/**
 * LOD3 = 6-plane box-impostor (variant A / "boxcards").
 * Six quads on the building AABB, each showing an ortho photo of that side.
 * Robust on hollow KitBash shells — we photograph appearance, not hull geometry.
 *
 * Contract (unchanged for engine):
 *   - lod3.glb + lod3_atlas/albedo.png
 *   - material "Lod3SilhouetteMaterial", alphaMode MASK, cutoff 0.5
 *   - asset.json lod3.backend = "boxcards"
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

/** Atlas tile order (row-major): +X -X +Y / -Y +Z -Z */
const FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

/**
 * @param {object} options
 * @param {string} options.inputGlb
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
    outDir,
    workDir,
    resolution = 2048,
    padding = PAD_PX,
    excludeGround = true,
  } = options;

  if (!existsSync(inputGlb)) {
    throw new Error(`LOD3 input missing: ${inputGlb}`);
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
    `  LOD3: boxcards 3×2 atlas ${atlasSize}px, pad=${pad}px` +
      `${excludeGround ? ', exclude-ground' : ''} from ${inputGlb}`,
  );

  const bake = await runBoxcardsBake({
    inputGlb,
    workDir,
    atlasSize,
    pad,
    excludeGround: excludeGround !== false,
  });

  writeFileSync(albedoPath, bake.atlasBytes);
  if (!existsSync(albedoPath) || statSync(albedoPath).size < MIN_ALBEDO_BYTES) {
    throw new Error('LOD3 QC: albedo.png missing or too small');
  }

  await buildBoxcardsGlb({
    outputGlb,
    atlasBytes: bake.atlasBytes,
    center: bake.center,
    size: bake.size,
    atlasSize: bake.atlasSize,
    tileSize: bake.tileSize,
    pad: bake.pad,
  });

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
    `  LOD3: OK — ${Math.round(tris)} tris, boxcards, MASK, atlas ${atlasSize}px` +
      ` (${(statSync(albedoPath).size / 1024).toFixed(0)} KB)`,
  );

  return {
    outputGlb,
    mapsDir,
    resolution: atlasSize,
    slices: 0,
    method: 'boxcards',
    triangles: Math.round(tris),
    backend: 'boxcards',
    alphaMode: 'MASK',
    faces: FACE_ORDER,
    padding: pad,
    center: bake.center,
    size: bake.size,
  };
}

async function runBoxcardsBake({
  inputGlb,
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
  const bakeHtml = join(workDir, '_lod3_bake.html');
  copyFileSync(inputGlb, stagedGlb);
  writeFileSync(
    bakeHtml,
    buildBakerHtml({ atlasSize, cell, pad, inner, excludeGround }),
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
      rmSync(bakeHtml, { force: true });
    } catch {
      // ignore
    }

    return {
      atlasBytes,
      center: data.center,
      size: data.size,
      atlasSize: data.atlasSize,
      tileSize: data.tileSize,
      pad: data.pad,
      excludedGround: !!data.excludedGround,
    };
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildBakerHtml({ atlasSize, cell, pad, inner, excludeGround }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>lod3 boxcards</title></head>
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
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const list = Array.isArray(obj.material) ? obj.material : [obj.material];
    const next = list.map((mat) => {
      if (!mat) return mat;
      const name = (mat.name || obj.name || '').toLowerCase();
      const isGlass = /glass|window|curtainwall/.test(name);
      if (isGlass) {
        return new THREE.MeshBasicMaterial({
          color: new THREE.Color(0xb4d0e8),
          transparent: true,
          opacity: 0.92,
          side: mat.side ?? THREE.FrontSide,
          depthWrite: true,
          toneMapped: false,
        });
      }
      const color = mat.color ? mat.color.clone() : new THREE.Color(0xffffff);
      color.multiplyScalar(1.45);
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

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 100000);

try {
  const gltf = await new GLTFLoader().loadAsync('/model.glb');
  prepareMaterials(gltf.scene);
  scene.add(gltf.scene);

  const { size, center, excludedGround } = computeAABB(gltf.scene);
  const margin = 1.02;

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

  window.__BOXCARDS__ = {
    ok: true,
    atlas: atlasCanvas.toDataURL('image/png'),
    center: { x: center.x, y: center.y, z: center.z },
    size: { x: size.x, y: size.y, z: size.z },
    atlasSize,
    tileSize: cell,
    pad,
    excludedGround,
    faces: faces.map((f) => f.name),
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

/**
 * Six AABB quads, outward winding, single MASK material + embedded atlas.
 * UV each face onto its 3×2 atlas cell (full cell including pad).
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
