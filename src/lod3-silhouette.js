/**
 * LOD3 = silhouette slice stack ("slicecards") with box-projected ortho atlas.
 *
 * v2 pipeline (research P1 — height-slice footprint stack):
 *   1. Six ortho photos of the building → 3×2 atlas (same as boxcards).
 *   2. Top-down heightmap of all triangles → per-pixel max Y.
 *   3. Roofline detection (histogram spikes) → K height bands (max 5).
 *   4. Per band: coverage mask (reaches band bottom) → morphological close →
 *      exterior flood fill → concave outer contours → Douglas–Peucker.
 *   5. Prism per contour per band; side walls + top caps.
 *   6. UVs = box projection: each face samples the ortho photo of its
 *      dominant normal direction — the photo "projects" onto the silhouette.
 *
 * Falls back to the 6-plane AABB boxcards when slice extraction fails.
 *
 * Contract (unchanged for engine):
 *   - lod3.glb + lod3_atlas/albedo.png
 *   - material "Lod3SilhouetteMaterial", alphaMode MASK, cutoff 0.5
 *   - asset.json lod3.backend = "slicecards" | "boxcards" (fallback)
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  copyFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { createServer } from 'node:http';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { ROOT } from './convert.js';

const MAX_TRIS = 3000;
const MIN_ALBEDO_BYTES = 2048;
const PAD_PX = 8;
const COLS = 3;
const ROWS = 2;
const MARGIN = 1.02;

/** Atlas tile order (row-major): +X -X +Y / -Y +Z -Z */
const FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

/**
 * Two sources, on purpose:
 *
 *   inputGlb      — geometry. Drives the AABB, the ground-plate heuristic and
 *                   the height-slice contours.
 *   appearanceGlb — what the six ortho cameras photograph. Point this at
 *                   lod2.glb so LOD3 inherits LOD2's baked look pixel for
 *                   pixel (Simplygon/UE proxy chain) instead of re-deriving it
 *                   in a second renderer with its own colour pipeline.
 *
 * Keeping them separate matters: lod2.glb is a single joined mesh, and
 * computeAABB()'s base-plate detection is per-object, so running the silhouette
 * off lod2 would silently disable exclude-ground and grow a solid slab under
 * every building. Both models share world space, so one AABB frames both.
 *
 * @param {object} options
 * @param {string} options.inputGlb geometry / silhouette source
 * @param {string} [options.appearanceGlb] photo source (default: inputGlb)
 * @param {string} options.outDir
 * @param {string} options.workDir
 * @param {number} [options.resolution] atlas edge px (default 2048)
 * @param {number} [options.padding] tile gutter px (default 8)
 * @param {boolean} [options.excludeGround] try to drop base plate from AABB Y (default true)
 * @param {number} [options.slices] ignored (legacy CLI compat)
 * @param {string} [options.method] ignored (legacy CLI compat)
 * @param {string|null} [options.blender] ignored
 */
export async function bakeLod3Silhouette(options) {
  const {
    inputGlb,
    appearanceGlb = null,
    outDir,
    workDir,
    resolution = 2048,
    padding = PAD_PX,
    excludeGround = true,
  } = options;

  if (!existsSync(inputGlb)) {
    throw new Error(`LOD3 input missing: ${inputGlb}`);
  }
  const lookGlb =
    appearanceGlb && existsSync(appearanceGlb) && appearanceGlb !== inputGlb
      ? appearanceGlb
      : null;
  if (appearanceGlb && !lookGlb && appearanceGlb !== inputGlb) {
    console.warn(
      `  LOD3: appearance source missing (${appearanceGlb}) — photographing geometry source`,
    );
  }

  const atlasSize = Math.max(512, Number(resolution) || 2048);
  const pad = Math.max(4, Math.min(16, Number(padding) || PAD_PX));
  const mapsDir = join(outDir, 'lod3_atlas');
  const outputGlb = join(outDir, 'lod3.glb');
  const albedoPath = join(mapsDir, 'albedo.png');

  mkdirSync(mapsDir, { recursive: true });
  mkdirSync(dirname(outputGlb), { recursive: true });
  mkdirSync(workDir, { recursive: true });

  console.log(
    `  LOD3: slicecards bake — atlas ${atlasSize}px 3×2, pad=${pad}px` +
      `${excludeGround ? ', exclude-ground' : ''}\n` +
      `        geometry   : ${inputGlb}\n` +
      `        appearance : ${lookGlb ?? '(same as geometry)'}`,
  );

  const bake = await runBoxcardsBake({
    inputGlb,
    lookGlb,
    workDir,
    atlasSize,
    pad,
    excludeGround: excludeGround !== false,
  });

  writeFileSync(albedoPath, bake.atlasBytes);
  if (!existsSync(albedoPath) || statSync(albedoPath).size < MIN_ALBEDO_BYTES) {
    throw new Error('LOD3 QC: albedo.png missing or too small');
  }

  let backend = 'boxcards';
  let sliceCount = 0;
  let built = false;

  const usableBands =
    Array.isArray(bake.slices?.bands) &&
    bake.slices.bands.some((b) => Array.isArray(b.polys) && b.polys.length > 0);

  if (usableBands) {
    try {
      const tris = await buildSlicecardsGlb({
        outputGlb,
        atlasBytes: bake.atlasBytes,
        center: bake.center,
        size: bake.size,
        bands: bake.slices.bands,
        atlasSize: bake.atlasSize,
        tileSize: bake.tileSize,
        pad: bake.pad,
        inner: bake.inner,
        margin: bake.margin ?? MARGIN,
      });
      if (tris <= 0 || tris > MAX_TRIS) {
        throw new Error(`slice stack ${tris} tris out of range (1..${MAX_TRIS})`);
      }
      backend = 'slicecards';
      sliceCount = bake.slices.bands.length;
      built = true;
      console.log(
        `  LOD3: slice stack — ${sliceCount} band(s), ` +
          `${bake.slices.bands.reduce((n, b) => n + b.polys.length, 0)} outline(s), ${tris} tris`,
      );
    } catch (err) {
      console.warn(`  LOD3: slice stack failed (${err.message}) — falling back to boxcards`);
    }
  } else {
    console.warn('  LOD3: no usable slice bands — falling back to boxcards');
  }

  if (!built) {
    await buildBoxcardsGlb({
      outputGlb,
      atlasBytes: bake.atlasBytes,
      center: bake.center,
      size: bake.size,
      atlasSize: bake.atlasSize,
      tileSize: bake.tileSize,
      pad: bake.pad,
    });
  }

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(outputGlb);
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      if (idx) tris += idx.getCount() / 3;
    }
  }
  if (tris <= 0 || tris > MAX_TRIS) {
    throw new Error(`LOD3 QC: triangle count ${tris} out of range (1..${MAX_TRIS})`);
  }

  for (const mat of doc.getRoot().listMaterials()) {
    mat.setName('Lod3SilhouetteMaterial');
    mat.setAlphaMode('MASK');
    mat.setAlphaCutoff(0.5);
    mat.setDoubleSided(false);
  }
  await io.write(outputGlb, doc);

  console.log(
    `  LOD3: OK — ${Math.round(tris)} tris, ${backend}, MASK, atlas ${atlasSize}px` +
      ` (${(statSync(albedoPath).size / 1024).toFixed(0)} KB)` +
      `${bake.photographedLook ? ', appearance from proxy chain' : ''}` +
      `${bake.excludedGround ? ', ground excluded' : ''}`,
  );

  return {
    outputGlb,
    mapsDir,
    resolution: atlasSize,
    slices: sliceCount,
    method: backend,
    triangles: Math.round(tris),
    backend,
    alphaMode: 'MASK',
    faces: FACE_ORDER,
    padding: pad,
    center: bake.center,
    size: bake.size,
    // Did the six photos actually come from the proxy-chain source, or did the
    // baker fall back to the geometry model? The pop fix depends on the former.
    photographedLook: !!bake.photographedLook,
    excludedGround: !!bake.excludedGround,
    boundariesY: bake.slices?.boundaries ?? [],
  };
}

async function runBoxcardsBake({
  inputGlb,
  lookGlb = null,
  workDir,
  atlasSize,
  pad,
  excludeGround,
}) {
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer')).default;
  } catch {
    throw new Error('LOD3 boxcards needs puppeteer — npm install puppeteer');
  }

  const threeRoot = join(ROOT, 'node_modules', 'three');
  if (!existsSync(join(threeRoot, 'build', 'three.module.js'))) {
    throw new Error('three package missing — npm install three');
  }

  const tileSize = Math.floor(atlasSize / Math.max(COLS, ROWS));
  // Square atlas: 3×2 cells of equal tileSize; leftover pixels stay empty on the right/bottom.
  const cell = tileSize;
  const inner = Math.max(1, cell - 2 * pad);

  const stagedGlb = join(workDir, '_lod3_source.glb');
  const stagedLookGlb = lookGlb ? join(workDir, '_lod3_look.glb') : null;
  const bakeHtml = join(workDir, '_lod3_bake.html');
  copyFileSync(inputGlb, stagedGlb);
  if (stagedLookGlb) copyFileSync(lookGlb, stagedLookGlb);
  writeFileSync(
    bakeHtml,
    buildBakerHtml({
      atlasSize,
      cell,
      pad,
      inner,
      excludeGround,
      hasLookModel: !!stagedLookGlb,
    }),
  );

  const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.glb': 'model/gltf-binary',
    '.png': 'image/png',
  };

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      let filePath;
      if (url.pathname === '/' || url.pathname === '/index.html') {
        filePath = bakeHtml;
      } else if (url.pathname === '/model.glb') {
        filePath = stagedGlb;
      } else if (url.pathname === '/look.glb' && stagedLookGlb) {
        filePath = stagedLookGlb;
      } else if (url.pathname.startsWith('/vendor/three/')) {
        filePath = join(threeRoot, url.pathname.slice('/vendor/three/'.length));
      } else if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      } else {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      const body = readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': mime[extname(filePath)] || 'application/octet-stream',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });

  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--enable-webgl2',
      '--use-gl=angle',
      '--use-angle=d3d11',
      '--enable-unsafe-swiftshader',
    ],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(300000);
    page.on('pageerror', (err) =>
      console.warn(`  LOD3 pageerror: ${err.message}`),
    );
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.warn(`  LOD3 console: ${msg.text()}`);
    });

    await page.setViewport({
      width: Math.min(atlasSize, 2048),
      height: Math.min(atlasSize, 2048),
      deviceScaleFactor: 1,
    });

    await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: 'networkidle0',
      timeout: 300000,
    });

    await page.waitForFunction(
      () =>
        window.__BOXCARDS__ &&
        (window.__BOXCARDS__.ok === true || window.__BOXCARDS__.ok === false),
      { timeout: 300000 },
    );

    const data = await page.evaluate(() => window.__BOXCARDS__);
    if (!data.ok) {
      throw new Error(`LOD3 boxcards bake failed: ${data.error}`);
    }

    const b64 = data.atlas.replace(/^data:image\/png;base64,/, '');
    const atlasBytes = Buffer.from(b64, 'base64');

    try {
      rmSync(stagedGlb, { force: true });
      if (stagedLookGlb) rmSync(stagedLookGlb, { force: true });
      rmSync(bakeHtml, { force: true });
    } catch {
      // ignore
    }

    return {
      atlasBytes,
      photographedLook: !!data.photographedLook,
      center: data.center,
      size: data.size,
      atlasSize: data.atlasSize,
      tileSize: data.tileSize,
      pad: data.pad,
      inner: data.inner ?? Math.max(1, data.tileSize - 2 * data.pad),
      margin: data.margin ?? MARGIN,
      excludedGround: !!data.excludedGround,
      slices: data.slices || null,
    };
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildBakerHtml({
  atlasSize,
  cell,
  pad,
  inner,
  excludeGround,
  hasLookModel = false,
}) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>lod3 slicecards</title></head>
<body style="margin:0;background:#000">
<canvas id="tile"></canvas>
<canvas id="atlas" width="${atlasSize}" height="${atlasSize}"></canvas>
<script type="importmap">
{
  "imports": {
    "three": "/vendor/three/build/three.module.js",
    "three/addons/": "/vendor/three/examples/jsm/"
  }
}
</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const atlasSize = ${atlasSize};
const cell = ${cell};
const pad = ${pad};
const inner = ${inner};
const excludeGround = ${excludeGround ? 'true' : 'false'};
const hasLookModel = ${hasLookModel ? 'true' : 'false'};
const margin = ${MARGIN};
const ss = 2;
const renderSize = Math.max(64, inner * ss);

const faces = [
  { name: 'px', dir: new THREE.Vector3( 1, 0, 0) },
  { name: 'nx', dir: new THREE.Vector3(-1, 0, 0) },
  { name: 'py', dir: new THREE.Vector3( 0, 1, 0) },
  { name: 'ny', dir: new THREE.Vector3( 0,-1, 0) },
  { name: 'pz', dir: new THREE.Vector3( 0, 0, 1) },
  { name: 'nz', dir: new THREE.Vector3( 0, 0,-1) },
];

const tileCanvas = document.getElementById('tile');
tileCanvas.width = renderSize;
tileCanvas.height = renderSize;
const atlasCanvas = document.getElementById('atlas');
const atlasCtx = atlasCanvas.getContext('2d', { willReadFrequently: true });
atlasCtx.imageSmoothingEnabled = true;
atlasCtx.imageSmoothingQuality = 'high';
atlasCtx.clearRect(0, 0, atlasSize, atlasSize);

const renderer = new THREE.WebGLRenderer({
  canvas: tileCanvas, alpha: true, antialias: true, preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
  failIfMajorPerformanceCaveat: false,
  premultipliedAlpha: false,
});
renderer.setSize(renderSize, renderSize, false);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 1.05));
scene.add(new THREE.HemisphereLight(0xf0f4ff, 0x889088, 0.9));
const sun = new THREE.DirectionalLight(0xfff5e8, 1.6);
sun.position.set(3, 6, 4);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xd0e0ff, 0.7);
fill.position.set(-4, 2, -2);
scene.add(fill);

function prepareMaterials(root) {
  // Albedo-attribute bake (gain 1.0). Engine lights LOD3 at runtime like LOD2.
  // Do NOT multiply colors or bake a lit pass — that double-lights and pops vs lod2.
  // Glass: when source is lod2 atlas, panes are already opaque proxy pixels — pass through.
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const list = Array.isArray(obj.material) ? obj.material : [obj.material];
    const next = list.map((mat) => {
      if (!mat) return mat;
      const color = mat.color ? mat.color.clone() : new THREE.Color(0xffffff);
      const basic = new THREE.MeshBasicMaterial({
        color,
        map: mat.map || null,
        alphaMap: mat.alphaMap || null,
        transparent: !!mat.transparent,
        opacity: mat.opacity ?? 1,
        alphaTest: mat.alphaTest || 0.02,
        side: mat.side ?? THREE.FrontSide,
        depthWrite: mat.depthWrite !== false,
        toneMapped: false,
      });
      if (basic.map) {
        basic.map.colorSpace = THREE.SRGBColorSpace;
        basic.map.needsUpdate = true;
      }
      return basic;
    });
    obj.material = Array.isArray(obj.material) ? next : next[0];
  });
}

/** Drop thin horizontal base plates near y=min from the AABB height. */
function computeAABB(root) {
  const full = new THREE.Box3().setFromObject(root);
  const size = full.getSize(new THREE.Vector3());
  const footprint = Math.max(size.x * size.z, 1e-6);
  let minY = full.min.y;
  let excluded = false;

  if (excludeGround && size.y > 1e-3) {
    let bestArea = 0;
    let bestMaxY = full.min.y;
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      const b = new THREE.Box3().setFromObject(obj);
      const s = b.getSize(new THREE.Vector3());
      if (s.y > size.y * 0.04) return;
      if (b.min.y > full.min.y + size.y * 0.08) return;
      const area = s.x * s.z;
      if (area < footprint * 0.35) return;
      if (area > bestArea) {
        bestArea = area;
        bestMaxY = b.max.y;
      }
    });
    if (bestArea > 0) {
      const raised = Math.min(bestMaxY, full.min.y + size.y * 0.25);
      if (raised > full.min.y + 1e-4 && raised < full.max.y - size.y * 0.2) {
        minY = raised;
        excluded = true;
      }
    }
  }

  const box = new THREE.Box3(
    new THREE.Vector3(full.min.x, minY, full.min.z),
    full.max.clone(),
  );
  const outSize = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  outSize.x = Math.max(outSize.x, 1e-3);
  outSize.y = Math.max(outSize.y, 1e-3);
  outSize.z = Math.max(outSize.z, 1e-3);
  return { box, size: outSize, center, excludedGround: excluded };
}

function dilateCell(tx, ty, passes) {
  const nPass = Math.max(0, passes | 0);
  if (nPass <= 0) return;
  const img = atlasCtx.getImageData(tx, ty, cell, cell);
  const w = cell, h = cell, data = img.data;
  for (let pass = 0; pass < nPass; pass++) {
    const copy = new Uint8ClampedArray(data);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (copy[i + 3] > 0) continue;
        let bestA = 0, br = 0, bg = 0, bb = 0;
        const nbs = [[x-1,y],[x+1,y],[x,y-1],[x,y+1]];
        for (const [nx, ny] of nbs) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = (ny * w + nx) * 4;
          if (copy[ni + 3] > bestA) {
            bestA = copy[ni + 3];
            br = copy[ni]; bg = copy[ni + 1]; bb = copy[ni + 2];
          }
        }
        if (bestA > 0) {
          data[i] = br; data[i+1] = bg; data[i+2] = bb; data[i+3] = bestA;
        }
      }
    }
  }
  atlasCtx.putImageData(img, tx, ty);
}

/**
 * Seal AABB cards: stairs/stoops cut MASK silhouettes short of card edges → corner gaps.
 * Nearest-color dilate, then fill any remaining inner holes so ±X/±Z meet.
 */
function fillCellOpaque(tx, ty) {
  const x0 = pad, y0 = pad, x1 = pad + inner, y1 = pad + inner;
  // Close typical stoop/stair bites without O(cell²) full-diagonal passes.
  dilateCell(tx, ty, Math.min(96, Math.max(pad * 4, 32)));

  const img = atlasCtx.getImageData(tx, ty, cell, cell);
  const w = cell, data = img.data;
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 10) continue;
      sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; sn++;
    }
  }
  const fr = sn ? Math.round(sr / sn) : 80;
  const fg = sn ? Math.round(sg / sn) : 80;
  const fb = sn ? Math.round(sb / sn) : 80;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] >= 10) {
        data[i + 3] = 255;
        continue;
      }
      data[i] = fr; data[i + 1] = fg; data[i + 2] = fb; data[i + 3] = 255;
    }
  }
  atlasCtx.putImageData(img, tx, ty);
  dilateCell(tx, ty, pad);
}

/** Force MASK-friendly coverage: opaque where any coverage, else fully transparent. */
function hardenCoverage() {
  const img = atlasCtx.getImageData(0, 0, atlasSize, atlasSize);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = d[i + 3] >= 10 ? 255 : 0;
  }
  atlasCtx.putImageData(img, 0, 0);
}

/* ============================================================
 * Silhouette slice extraction (heightmap → bands → contours)
 * ============================================================ */

const GRID = 256;
const BORDER = 2;
const MAX_BOUNDARIES = 4;
const MAX_POLYS_PER_BAND = 4;
const MAX_VERTS_PER_POLY = 36;

function extractSlices(root, box, size, center) {
  const W = GRID + 2 * BORDER;
  const minY = box.min.y;
  const maxY = box.max.y;
  const spanY = Math.max(maxY - minY, 1e-6);
  const ox = center.x - size.x / 2;
  const oz = center.z - size.z / 2;
  const sx = GRID / Math.max(size.x, 1e-6);
  const sz = GRID / Math.max(size.z, 1e-6);

  // --- 1) top-down heightmap: per-pixel max world Y --------------------
  const H = new Float32Array(W * W).fill(-1e30);
  const gx = (x) => BORDER + (x - ox) * sx;
  const gz = (z) => BORDER + (z - oz) * sz;
  const clampi = (v) => Math.max(0, Math.min(W - 1, v));

  const paint = (px, pz, y) => {
    const ix = clampi(Math.floor(px));
    const iz = clampi(Math.floor(pz));
    const idx = iz * W + ix;
    if (y > H[idx]) H[idx] = y;
  };

  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const pos = obj.geometry.attributes.position;
    if (!pos) return;
    const index = obj.geometry.index;
    const m = obj.matrixWorld;
    const triCount = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      va.fromBufferAttribute(pos, i0).applyMatrix4(m);
      vb.fromBufferAttribute(pos, i1).applyMatrix4(m);
      vc.fromBufferAttribute(pos, i2).applyMatrix4(m);

      const ax = gx(va.x), az = gz(va.z), ay = va.y;
      const bx = gx(vb.x), bz = gz(vb.z), by = vb.y;
      const cx = gx(vc.x), cz = gz(vc.z), cy = vc.y;

      // Edges (walls project to lines — always rasterize)
      rasterEdge(ax, az, ay, bx, bz, by, paint);
      rasterEdge(bx, bz, by, cx, cz, cy, paint);
      rasterEdge(cx, cz, cy, ax, az, ay, paint);

      // Area fill with barycentric-interpolated Y
      const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      if (Math.abs(area) < 1e-9) continue;
      const x0i = clampi(Math.floor(Math.min(ax, bx, cx)));
      const x1i = clampi(Math.ceil(Math.max(ax, bx, cx)));
      const z0i = clampi(Math.floor(Math.min(az, bz, cz)));
      const z1i = clampi(Math.ceil(Math.max(az, bz, cz)));
      for (let iz = z0i; iz <= z1i; iz++) {
        const pzc = iz + 0.5;
        for (let ix = x0i; ix <= x1i; ix++) {
          const pxc = ix + 0.5;
          const w0 = (bx - pxc) * (cz - pzc) - (bz - pzc) * (cx - pxc);
          const w1 = (cx - pxc) * (az - pzc) - (cz - pzc) * (ax - pxc);
          const w2 = (ax - pxc) * (bz - pzc) - (az - pzc) * (bx - pxc);
          if (
            (w0 >= 0 && w1 >= 0 && w2 >= 0 && area > 0) ||
            (w0 <= 0 && w1 <= 0 && w2 <= 0 && area < 0)
          ) {
            const y = (w0 * ay + w1 * by + w2 * cy) / area;
            const idx = iz * W + ix;
            if (y > H[idx]) H[idx] = y;
          }
        }
      }
    }
  });

  // --- 2) roofline detection: histogram spikes of per-pixel max Y ------
  const coverThresh = minY + 0.015 * spanY;
  const BINS = 96;
  const hist = new Uint32Array(BINS);
  let coverCount = 0;
  for (let i = 0; i < W * W; i++) {
    const h = H[i];
    if (h < coverThresh) continue;
    coverCount++;
    const bin = Math.max(
      0,
      Math.min(BINS - 1, Math.floor(((h - minY) / spanY) * BINS)),
    );
    hist[bin]++;
  }
  if (coverCount < 64) throw new Error('slice grid: too few covered pixels');

  const cand = [];
  for (let b = 0; b < BINS; b++) {
    if (hist[b] >= coverCount * 0.02) {
      cand.push({ count: hist[b], y: minY + ((b + 1) / BINS) * spanY });
    }
  }
  cand.sort((a, b) => b.count - a.count);
  const minSep = 0.06 * spanY;
  const boundaries = [];
  for (const c of cand) {
    if (boundaries.length >= MAX_BOUNDARIES) break;
    if (c.y - minY < minSep || maxY - c.y < minSep) continue;
    if (boundaries.some((y) => Math.abs(y - c.y) < minSep)) continue;
    boundaries.push(c.y);
  }
  boundaries.sort((a, b) => a - b);

  // --- 3) per-band mask → close → fill interior → contours -------------
  const ys = [minY, ...boundaries, maxY];
  const bands = [];
  for (let bi = 0; bi < ys.length - 1; bi++) {
    const y0 = ys[bi];
    const y1 = ys[bi + 1];
    const thresh = bi === 0 ? coverThresh : y0 + 0.02 * spanY;
    let mask = new Uint8Array(W * W);
    for (let i = 0; i < W * W; i++) mask[i] = H[i] >= thresh ? 1 : 0;

    mask = morph(mask, W, 2, 1); // dilate 2
    fillInterior(mask, W);
    mask = morph(mask, W, 2, 0); // erode 2

    const polysPx = traceComponents(mask, W, coverCount);
    const polys = [];
    for (const contour of polysPx) {
      // Radial fit BEFORE Douglas–Peucker — DP turns circles into arbitrary
      // polygons whose perimeter fails circularity tests.
      const round = regularizeRoundContour(contour);
      let simple;
      if (round) {
        simple = round;
      } else {
        let eps = 2.0;
        simple = simplifyClosed(contour, eps);
        while (simple.length > MAX_VERTS_PER_POLY && eps < 16) {
          eps *= 1.4;
          simple = simplifyClosed(contour, eps);
        }
      }
      if (simple.length < 3) continue;
      polys.push(
        simple.map(([px, pz]) => [
          ox + (px - BORDER + 0.5) / sx,
          oz + (pz - BORDER + 0.5) / sz,
        ]),
      );
    }
    if (polys.length > 0) bands.push({ y0, y1, polys });
  }

  return { bands, boundaries, coverCount };
}

/**
 * If contour is nearly circular, replace with a regular N-gon.
 * Squares fail (~41% radial deviation); octagons fail (~8%); cylinders pass.
 *
 * Contour coords are GRID pixels here (pre world-space mapping), so the
 * tolerance carries an absolute floor as well: a Moore trace on a 256 grid
 * staircases by ~1px, which on a small footprint (r ≈ 10px) is already 7% and
 * would reject an otherwise perfect cylinder on quantisation noise alone.
 *
 * @param {Array<[number, number]>} contour
 * @returns {Array<[number, number]>|null}
 */
function regularizeRoundContour(contour) {
  if (!contour || contour.length < 8) return null;
  let cx = 0;
  let cz = 0;
  for (const [x, z] of contour) {
    cx += x;
    cz += z;
  }
  cx /= contour.length;
  cz /= contour.length;
  const radii = contour.map(([x, z]) => Math.hypot(x - cx, z - cz));
  const rBar = radii.reduce((a, b) => a + b, 0) / radii.length;
  if (rBar < 1e-3) return null;
  // Measured max |r − r̄| on densely traced outlines (GRID px):
  //   circle r=40 0.55 · r=20 0.39 · r=10 0.34   (pure rounding noise, flat in r)
  //   12-gon 1.27 · octagon r=40 2.03 · r=20 1.01 · hexagon 3.72   (grows with r)
  // A relative bound alone rejects small circles (r=10 is already 3.4%); an
  // absolute one alone accepts large octagons. Both together separate cleanly,
  // and the safe failure direction is rejecting — a bumpy cylinder just keeps
  // its DP polygon, whereas circularising a rectangular tower is very visible.
  let maxDev = 0;
  for (const r of radii) maxDev = Math.max(maxDev, Math.abs(r - rBar));
  if (maxDev >= Math.max(0.045 * rBar, 0.8)) return null;

  const n = 20;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * rBar, cz + Math.sin(a) * rBar]);
  }
  return out;
}

function rasterEdge(ax, az, ay, bx, bz, by, paint) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(bz - az))));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    paint(ax + (bx - ax) * t, az + (bz - az) * t, ay + (by - ay) * t);
  }
}

/** 4-neighbourhood dilate (target=1) or erode (target=0), n passes. */
function morph(mask, W, passes, dilate) {
  let cur = mask;
  for (let p = 0; p < passes; p++) {
    const next = new Uint8Array(cur);
    for (let z = 0; z < W; z++) {
      for (let x = 0; x < W; x++) {
        const i = z * W + x;
        if (dilate ? cur[i] === 1 : cur[i] === 0) continue;
        const hit =
          (x > 0 && cur[i - 1] === dilate) ||
          (x < W - 1 && cur[i + 1] === dilate) ||
          (z > 0 && cur[i - W] === dilate) ||
          (z < W - 1 && cur[i + W] === dilate);
        if (hit) next[i] = dilate;
      }
    }
    cur = next;
  }
  return cur;
}

/** Flood-fill exterior from the border; every non-exterior pixel becomes 1. */
function fillInterior(mask, W) {
  const ext = new Uint8Array(W * W);
  const stack = [0];
  ext[0] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % W;
    const z = (i / W) | 0;
    const nbs = [
      x > 0 ? i - 1 : -1,
      x < W - 1 ? i + 1 : -1,
      z > 0 ? i - W : -1,
      z < W - 1 ? i + W : -1,
    ];
    for (const n of nbs) {
      if (n < 0 || ext[n] || mask[n]) continue;
      ext[n] = 1;
      stack.push(n);
    }
  }
  for (let i = 0; i < W * W; i++) {
    if (!ext[i]) mask[i] = 1;
  }
}

/** Connected components (largest first, capped) → Moore-traced outer contours. */
function traceComponents(mask, W, coverCount) {
  const label = new Int32Array(W * W).fill(-1);
  const comps = [];
  for (let i = 0; i < W * W; i++) {
    if (mask[i] !== 1 || label[i] !== -1) continue;
    const id = comps.length;
    let count = 0;
    let seed = i;
    const stack = [i];
    label[i] = id;
    while (stack.length) {
      const j = stack.pop();
      count++;
      if (j < seed) seed = j;
      const x = j % W;
      const z = (j / W) | 0;
      const nbs = [
        x > 0 ? j - 1 : -1,
        x < W - 1 ? j + 1 : -1,
        z > 0 ? j - W : -1,
        z < W - 1 ? j + W : -1,
      ];
      for (const n of nbs) {
        if (n < 0 || mask[n] !== 1 || label[n] !== -1) continue;
        label[n] = id;
        stack.push(n);
      }
    }
    comps.push({ id, count, seed });
  }

  comps.sort((a, b) => b.count - a.count);
  const minArea = Math.max(24, coverCount * 0.01);
  const contours = [];
  for (const comp of comps) {
    if (contours.length >= MAX_POLYS_PER_BAND) break;
    if (comp.count < minArea) continue;
    const contour = mooreTrace(mask, label, W, comp);
    if (contour && contour.length >= 3) contours.push(contour);
  }
  return contours;
}

/** Moore-neighbour boundary trace of one labelled component. */
function mooreTrace(mask, label, W, comp) {
  const inside = (x, z) =>
    x >= 0 && z >= 0 && x < W && z < W && label[z * W + x] === comp.id;
  const sx = comp.seed % W;
  const sz = (comp.seed / W) | 0;
  // 8 directions clockwise starting west
  const DX = [-1, -1, 0, 1, 1, 1, 0, -1];
  const DZ = [0, -1, -1, -1, 0, 1, 1, 1];
  const contour = [];
  let cx = sx, cz = sz;
  // dir = direction of the last move; seed is topmost-left → pretend we
  // arrived moving east so the first scan starts at NW (just past backtrack).
  let dir = 4;
  const maxSteps = W * W * 4;
  let steps = 0;
  do {
    contour.push([cx, cz]);
    let found = false;
    // scan clockwise starting just after the backtrack direction
    for (let k = 0; k < 8; k++) {
      const d = (dir + 5 + k) % 8;
      const nx = cx + DX[d];
      const nz = cz + DZ[d];
      if (inside(nx, nz)) {
        cx = nx;
        cz = nz;
        dir = d;
        found = true;
        break;
      }
    }
    if (!found) break; // isolated pixel
    steps++;
  } while ((cx !== sx || cz !== sz) && steps < maxSteps);
  return contour;
}

/** Douglas–Peucker on a closed contour: split at farthest point from v0. */
function simplifyClosed(points, eps) {
  if (points.length <= 4) return points.slice();
  let far = 1;
  let farDist = -1;
  const [x0, z0] = points[0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - x0;
    const dz = points[i][1] - z0;
    const d = dx * dx + dz * dz;
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }
  const half1 = dpSimplify(points.slice(0, far + 1), eps);
  const half2 = dpSimplify(points.slice(far).concat([points[0]]), eps);
  const out = half1.slice(0, -1).concat(half2.slice(0, -1));
  return out;
}

function dpSimplify(pts, eps) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1e-9;
    let maxD = -1;
    let maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dx * (az - pts[i][1]) - dz * (ax - pts[i][0])) / len;
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > eps) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 100000);

try {
  const loader = new GLTFLoader();

  // Geometry model: AABB, ground-plate heuristic, height-slice contours.
  // It is never added to the render scene — only measured.
  const geomGltf = await loader.loadAsync('/model.glb');
  geomGltf.scene.updateWorldMatrix(true, true);

  // Appearance model: the only thing the six ortho cameras see. Falls back to
  // the geometry model when no separate look source was staged.
  let lookRoot = geomGltf.scene;
  let photographedLook = false;
  if (hasLookModel) {
    try {
      const lookGltf = await loader.loadAsync('/look.glb');
      lookRoot = lookGltf.scene;
      photographedLook = true;
    } catch (e) {
      console.error('LOD3 look model failed, photographing geometry: ' + (e && e.message ? e.message : e));
      lookRoot = geomGltf.scene;
    }
  }

  prepareMaterials(lookRoot);
  scene.add(lookRoot);

  // Frame from the GEOMETRY AABB even when photographing the look model — both
  // share world space, and only the geometry model has the per-object structure
  // that the base-plate heuristic needs (lod2.glb is one joined mesh).
  const { box, size, center, excludedGround } = computeAABB(geomGltf.scene);

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const dir = face.dir.clone().normalize();
    // Aspect-correct ortho = face size (no square letterbox → no thin MASK strip).
    // Stretch into square atlas tile; UV on rectangular quad restores aspect.
    let orthoW, orthoH;
    if (Math.abs(dir.y) > 0.9) {
      orthoW = size.x * margin;
      orthoH = size.z * margin;
    } else if (Math.abs(dir.x) > 0.9) {
      orthoW = size.z * margin;
      orthoH = size.y * margin;
    } else {
      orthoW = size.x * margin;
      orthoH = size.y * margin;
    }

    camera.left = -orthoW / 2;
    camera.right = orthoW / 2;
    camera.top = orthoH / 2;
    camera.bottom = -orthoH / 2;
    camera.near = 0.05;
    camera.far = Math.max(size.x, size.y, size.z) * 40;
    camera.updateProjectionMatrix();

    const dist = Math.max(size.x, size.y, size.z) * 2.5;
    camera.position.copy(center).addScaledVector(dir, dist);
    if (Math.abs(dir.y) > 0.9) {
      camera.up.set(0, 0, dir.y > 0 ? -1 : 1);
    } else {
      camera.up.set(0, 1, 0);
    }
    camera.lookAt(center);

    renderer.render(scene, camera);

    const col = fi % 3;
    const row = Math.floor(fi / 3);
    const tx = col * cell;
    const ty = row * cell;
    atlasCtx.clearRect(tx, ty, cell, cell);
    // Fill entire inner cell (stretch) so opaque coverage spans the quad.
    atlasCtx.drawImage(
      tileCanvas, 0, 0, renderSize, renderSize,
      tx + pad, ty + pad, inner, inner,
    );
    // Pad bleed + fill AABB rect opaque (closes stair/stoop corner gaps).
    dilateCell(tx, ty, pad);
    fillCellOpaque(tx, ty);
  }

  hardenCoverage();

  let slices = null;
  try {
    slices = extractSlices(geomGltf.scene, box, size, center);
  } catch (err) {
    console.error('LOD3 slice extraction failed: ' + (err && err.message ? err.message : err));
  }

  window.__BOXCARDS__ = {
    ok: true,
    photographedLook,
    atlas: atlasCanvas.toDataURL('image/png'),
    center: { x: center.x, y: center.y, z: center.z },
    size: { x: size.x, y: size.y, z: size.z },
    atlasSize,
    tileSize: cell,
    pad,
    inner,
    margin,
    excludedGround,
    faces: faces.map((f) => f.name),
    slices,
  };
} catch (err) {
  window.__BOXCARDS__ = {
    ok: false,
    error: String(err && err.message ? err.message : err),
  };
}
</script>
</body></html>`;
}

/* ============================================================
 * Node-side mesh builders
 * ============================================================ */

/**
 * Silhouette slice stack: one prism per band outline, side walls + top caps.
 * UVs box-project each face onto the ortho photo of its dominant direction,
 * replicating the baker's camera framing (margin + pad/inner cell layout).
 */
async function buildSlicecardsGlb({
  outputGlb,
  atlasBytes,
  center,
  size,
  bands,
  atlasSize,
  tileSize,
  pad,
  inner,
  margin,
}) {
  const cell = tileSize;
  // Face projections: a = camera-right coord, b = camera-up coord (relative to center).
  const FACES = {
    px: { col: 0, row: 0, a: (x, y, z) => -z, b: (x, y, z) => y, ow: size.z, oh: size.y },
    nx: { col: 1, row: 0, a: (x, y, z) => z, b: (x, y, z) => y, ow: size.z, oh: size.y },
    py: { col: 2, row: 0, a: (x, y, z) => x, b: (x, y, z) => -z, ow: size.x, oh: size.z },
    pz: { col: 1, row: 1, a: (x, y, z) => x, b: (x, y, z) => y, ow: size.x, oh: size.y },
    nz: { col: 2, row: 1, a: (x, y, z) => -x, b: (x, y, z) => y, ow: size.x, oh: size.y },
  };

  const uvFor = (faceName, x, y, z) => {
    const f = FACES[faceName];
    const a = f.a(x, y, z);
    const b = f.b(x, y, z);
    const u = (f.col * cell + pad + inner * (0.5 + a / (f.ow * margin))) / atlasSize;
    const v = (f.row * cell + pad + inner * (0.5 - b / (f.oh * margin))) / atlasSize;
    return [u, v];
  };

  const positions = [];
  const uvs = [];
  const indices = [];
  let vertCount = 0;

  const pushVert = (x, y, z, faceName) => {
    positions.push(x, y, z);
    const [u, v] = uvFor(faceName, x, y, z);
    uvs.push(u, v);
    return vertCount++;
  };

  for (const band of bands) {
    const yLo = band.y0 - center.y;
    const yHi = band.y1 - center.y;
    for (const rawPoly of band.polys) {
      const poly = orientPoly(
        rawPoly.map(([x, z]) => [x - center.x, z - center.z]),
      );
      if (poly.length < 3) continue;

      // Side walls: one quad per edge, projected onto the dominant-normal photo.
      for (let i = 0; i < poly.length; i++) {
        const [px_, pz_] = poly[i];
        const [qx, qz] = poly[(i + 1) % poly.length];
        const nx = pz_ - qz;
        const nz = qx - px_;
        if (Math.abs(nx) < 1e-9 && Math.abs(nz) < 1e-9) continue;
        const face =
          Math.abs(nx) >= Math.abs(nz)
            ? nx > 0
              ? 'px'
              : 'nx'
            : nz > 0
              ? 'pz'
              : 'nz';
        const a = pushVert(px_, yLo, pz_, face);
        const b = pushVert(qx, yLo, qz, face);
        const c = pushVert(qx, yHi, qz, face);
        const d = pushVert(px_, yHi, pz_, face);
        indices.push(a, b, c, a, c, d);
      }

      // Top cap: ear-clip, textured from the top photo.
      const capTris = triangulatePoly(poly);
      if (capTris.length) {
        const capIdx = poly.map(([x, z]) => pushVert(x, yHi, z, 'py'));
        for (const [i0, i1, i2] of capTris) {
          indices.push(capIdx[i0], capIdx[i1], capIdx[i2]);
        }
      }
    }
  }

  if (indices.length < 3) {
    throw new Error('slice stack produced no triangles');
  }

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Lod3Slicecards');
  const rootNode = doc
    .createNode('Lod3Slicecards')
    .setTranslation([center.x, center.y, center.z]);
  scene.addChild(rootNode);

  const texture = doc
    .createTexture('Lod3Atlas')
    .setImage(atlasBytes)
    .setMimeType('image/png');

  const material = doc
    .createMaterial('Lod3SilhouetteMaterial')
    .setBaseColorTexture(texture)
    .setAlphaMode('MASK')
    .setAlphaCutoff(0.5)
    .setDoubleSided(false)
    .setMetallicFactor(0)
    .setRoughnessFactor(1);

  const posAcc = doc
    .createAccessor('slice_pos')
    .setType('VEC3')
    .setArray(new Float32Array(positions))
    .setBuffer(buffer);
  const uvAcc = doc
    .createAccessor('slice_uv')
    .setType('VEC2')
    .setArray(new Float32Array(uvs))
    .setBuffer(buffer);
  const idxAcc = doc
    .createAccessor('slice_idx')
    .setType('SCALAR')
    .setArray(
      vertCount <= 65534 ? new Uint16Array(indices) : new Uint32Array(indices),
    )
    .setBuffer(buffer);

  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', posAcc)
    .setAttribute('TEXCOORD_0', uvAcc)
    .setIndices(idxAcc)
    .setMaterial(material)
    .setMode(4);

  rootNode.setMesh(doc.createMesh('Lod3SlicecardsMesh').addPrimitive(prim));

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  await io.write(outputGlb, doc);
  return indices.length / 3;
}

/**
 * Enforce the winding that makes side-wall normals point outward
 * (negative shoelace sum in the XZ plane; +Y-up caps under ear clipping).
 */
function orientPoly(poly) {
  let area2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i];
    const [x1, z1] = poly[(i + 1) % poly.length];
    area2 += x0 * z1 - x1 * z0;
  }
  return area2 < 0 ? poly : poly.slice().reverse();
}

/**
 * Ear clipping for a simple polygon in orientPoly() winding.
 * Returns triangles as index triples into the polygon; falls back to a fan
 * when no ear is found (rare self-intersections after DP).
 */
function triangulatePoly(poly) {
  const n = poly.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  const idx = Array.from({ length: n }, (_, i) => i);
  const tris = [];
  // In this winding, convex corners have negative cross product.
  const cross = (a, b, c) =>
    (poly[b][0] - poly[a][0]) * (poly[c][1] - poly[b][1]) -
    (poly[b][1] - poly[a][1]) * (poly[c][0] - poly[b][0]);
  const inTri = (a, b, c, p) => {
    const d1 = cross2(poly[a], poly[b], poly[p]);
    const d2 = cross2(poly[b], poly[c], poly[p]);
    const d3 = cross2(poly[c], poly[a], poly[p]);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };

  let guard = 0;
  while (idx.length > 3 && guard < 10000) {
    guard++;
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length];
      const b = idx[i];
      const c = idx[(i + 1) % idx.length];
      if (cross(a, b, c) >= 0) continue; // reflex or collinear
      let blocked = false;
      for (const p of idx) {
        if (p === a || p === b || p === c) continue;
        if (inTri(a, b, c, p)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      tris.push([a, b, c]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Degenerate leftover — fan it and stop.
      for (let i = 1; i < idx.length - 1; i++) {
        tris.push([idx[0], idx[i], idx[i + 1]]);
      }
      return tris;
    }
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

function cross2(p, q, r) {
  return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
}

/**
 * Six AABB quads, outward winding, single MASK material + embedded atlas.
 * UV each face onto its 3×2 atlas cell (full cell including pad).
 * Fallback when slice extraction fails.
 */
async function buildBoxcardsGlb({
  outputGlb,
  atlasBytes,
  center,
  size,
  atlasSize,
  tileSize,
  pad,
}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Lod3Boxcards');
  const rootNode = doc
    .createNode('Lod3Boxcards')
    .setTranslation([center.x, center.y, center.z]);
  scene.addChild(rootNode);

  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;

  /**
   * Quads on AABB walls, winding CCW from OUTSIDE (engine culls backfaces).
   * Vertex order matches legacy box impostor (verified outward normals).
   * Order = FACE_ORDER: px, nx, py, ny, pz, nz.
   */
  const faceGeom = [
    {
      // +X (right)
      positions: [hx, -hy, hz, hx, -hy, -hz, hx, hy, -hz, hx, hy, hz],
    },
    {
      // -X (left)
      positions: [-hx, -hy, -hz, -hx, -hy, hz, -hx, hy, hz, -hx, hy, -hz],
    },
    {
      // +Y (top)
      positions: [-hx, hy, hz, hx, hy, hz, hx, hy, -hz, -hx, hy, -hz],
    },
    {
      // -Y (bottom)
      positions: [-hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz],
    },
    {
      // +Z (front)
      positions: [-hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz],
    },
    {
      // -Z (back)
      positions: [hx, -hy, -hz, -hx, -hy, -hz, -hx, hy, -hz, hx, hy, -hz],
    },
  ];
  const indices = [0, 1, 2, 0, 2, 3];

  const texture = doc
    .createTexture('Lod3Atlas')
    .setImage(atlasBytes)
    .setMimeType('image/png');

  const material = doc
    .createMaterial('Lod3SilhouetteMaterial')
    .setBaseColorTexture(texture)
    .setAlphaMode('MASK')
    .setAlphaCutoff(0.5)
    .setDoubleSided(false)
    .setMetallicFactor(0)
    .setRoughnessFactor(1);

  const mesh = doc.createMesh('Lod3BoxcardsMesh');

  for (let fi = 0; fi < faceGeom.length; fi++) {
    const col = fi % COLS;
    const row = Math.floor(fi / COLS);
    // UV over full cell (pad is dilated coverage — safe under CLAMP + no mips)
    // glTF: V=0 = top of image; V increases downward
    const u0 = (col * tileSize) / atlasSize;
    const u1 = ((col + 1) * tileSize) / atlasSize;
    const vTop = (row * tileSize) / atlasSize;
    const vBot = ((row + 1) * tileSize) / atlasSize;
    // Quad verts 0..3 → bottom-left, bottom-right, top-right, top-left in face space
    const uvs = [u0, vBot, u1, vBot, u1, vTop, u0, vTop];

    const posAcc = doc
      .createAccessor(`${FACE_ORDER[fi]}_pos`)
      .setType('VEC3')
      .setArray(new Float32Array(faceGeom[fi].positions))
      .setBuffer(buffer);

    const uvAcc = doc
      .createAccessor(`${FACE_ORDER[fi]}_uv`)
      .setType('VEC2')
      .setArray(new Float32Array(uvs))
      .setBuffer(buffer);

    const idxAcc = doc
      .createAccessor(`${FACE_ORDER[fi]}_idx`)
      .setType('SCALAR')
      .setArray(new Uint16Array(indices))
      .setBuffer(buffer);

    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', posAcc)
      .setAttribute('TEXCOORD_0', uvAcc)
      .setIndices(idxAcc)
      .setMaterial(material)
      .setMode(4);

    mesh.addPrimitive(prim);
  }

  rootNode.setMesh(mesh);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  await io.write(outputGlb, doc);
  void pad; // reserved for future UV inset
}
