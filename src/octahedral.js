/**
 * Hemi-octahedral impostor baker (Ryan Brucks style).
 * Bakes frames² orthographic views into one atlas + a single billboard quad GLB.
 * Runtime needs a custom shader (see runtime/octahedral-impostor.js) — Blender
 * cannot view-dependently sample the atlas.
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { createServer } from 'node:http';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { ROOT } from './convert.js';

/**
 * @param {object} options
 * @param {string} options.inputGlb
 * @param {string} options.outputGlb
 * @param {string} options.outDir final outputs (atlas, preview)
 * @param {string} [options.stageDir] staging for _source/_bake (defaults to outDir)
 * @param {number} [options.atlasSize] atlas edge px (default 4096)
 * @param {number} [options.frames] grid size (default 12 → 144 views)
 * @param {boolean} [options.hemi] hemi-octahedron for buildings (default true)
 * @param {number} [options.gutterPx] tile border dilate px (default 2, or 4 if tile ≤ 128)
 * @param {string|null} [options.kitId]
 * @param {string|null} [options.atlasId]
 */
export async function generateOctahedralImpostor(options) {
  const {
    inputGlb,
    outputGlb,
    outDir,
    stageDir = outDir,
    atlasSize = 4096,
    frames = 12,
    hemi = true,
    kitId = null,
    atlasId = null,
  } = options;

  const tileSize = Math.floor(atlasSize / frames);
  const gutterPx =
    options.gutterPx != null
      ? Math.max(0, options.gutterPx | 0)
      : tileSize <= 128
        ? 4
        : 2;
  const alphaCutoff = 0.35;

  mkdirSync(outDir, { recursive: true });
  mkdirSync(stageDir, { recursive: true });
  mkdirSync(dirname(outputGlb), { recursive: true });

  let puppeteer;
  try {
    puppeteer = (await import('puppeteer')).default;
  } catch {
    throw new Error('Octahedral bake needs puppeteer — npm install puppeteer');
  }

  const threeRoot = join(ROOT, 'node_modules', 'three');
  if (!existsSync(join(threeRoot, 'build', 'three.module.js'))) {
    throw new Error('three package missing — npm install three');
  }

  const stagedGlb = join(stageDir, '_source.glb');
  const bakeHtml = join(stageDir, '_bake.html');
  copyFileSync(inputGlb, stagedGlb);

  const html = buildBakerHtml({ atlasSize, frames, hemi, gutterPx });
  writeFileSync(bakeHtml, html);

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
        res.end('not found: ' + url.pathname);
        console.warn(`  octahedral 404: ${url.pathname}`);
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
      // Windows: Angle→D3D11 usually works; SwiftShader as software fallback.
      '--use-gl=angle',
      '--use-angle=d3d11',
      '--enable-unsafe-swiftshader',
    ],
  });

  try {
    const page = await browser.newPage();
    // Heavy meshes: long load + per-row bake; don't kill mid-atlas.
    page.setDefaultTimeout(600000);
    page.on('pageerror', (err) =>
      console.warn(`  octahedral pageerror: ${err.message}\n${err.stack || ''}`),
    );
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.warn(`  octahedral console: ${msg.text()}`);
      } else if (msg.text().startsWith('[bake]')) {
        console.log(`  ${msg.text()}`);
      }
    });

    await page.setViewport({
      width: Math.min(atlasSize, 2048),
      height: Math.min(atlasSize, 2048),
      deviceScaleFactor: 1,
    });

    await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: 'networkidle0',
      timeout: 600000,
    });

    await page.waitForFunction(
      () =>
        window.__OCTA_API__ &&
        (window.__OCTA_API__.ready === true || window.__OCTA_API__.error),
      { timeout: 600000 },
    );

    const boot = await page.evaluate(() => ({
      ready: window.__OCTA_API__.ready,
      error: window.__OCTA_API__.error || null,
    }));
    if (!boot.ready) {
      throw new Error(`Octahedral bake failed to load model: ${boot.error}`);
    }

    // Bake one row at a time so Chromium can breathe (avoids single 144-frame hang).
    for (let j = 0; j < frames; j++) {
      const row = await page.evaluate(async (rowIndex) => {
        try {
          await window.__OCTA_API__.bakeRow(rowIndex);
          return { ok: true, row: rowIndex };
        } catch (err) {
          return {
            ok: false,
            row: rowIndex,
            error: String(err && err.message ? err.message : err),
          };
        }
      }, j);
      if (!row.ok) {
        throw new Error(`Octahedral bake row ${row.row} failed: ${row.error}`);
      }
      if (j % 2 === 0 || j === frames - 1) {
        console.log(`  [bake] row ${j + 1} / ${frames}`);
      }
    }

    const data = await page.evaluate(() => window.__OCTA_API__.finish());
    if (!data.ok) {
      throw new Error(`Octahedral bake failed: ${data.error}`);
    }

    const atlasB64 = data.atlas.replace(/^data:image\/png;base64,/, '');
    const atlasBytes = Buffer.from(atlasB64, 'base64');
    const atlasPath = join(outDir, 'impostor_atlas.png');
    writeFileSync(atlasPath, atlasBytes);
    console.log(
      `  octahedral: atlas ${atlasSize}px / ${frames}×${frames} gutter=${gutterPx}px premult (${(atlasBytes.length / 1024).toFixed(0)} KB)`,
    );

    const meta = {
      version: 1,
      type: 'octahedral',
      hemi: !!hemi,
      frames,
      atlasSize,
      atlas: 'impostor_atlas.png',
      atlasOrigin: 'top-left',
      atlasLayout: 'j0_top',
      gutterPx: data.gutterPx ?? gutterPx,
      alphaMode: 'premultiplied',
      colorSpace: 'srgb',
      mipPolicy: 'engine-from-png',
      alphaCutoff,
      transitionScreenSize: 0.07,
      channelMap: { albedo: 'RGBA', alpha: 'coverage' },
      kitId,
      atlasId,
      center: data.center,
      radius: data.radius,
      size: data.size,
      generatedAt: new Date().toISOString(),
      note: 'Open preview.html in a browser. Engine: 3-frame barycentric sample + UV clamp into tile (gutter-safe). Atlas RGB is premultiplied by A.',
    };
    const metaPath = join(outDir, 'impostor.json');
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    await buildBillboardGlb({
      outputGlb,
      center: data.center,
      radius: data.radius,
      atlasBytes,
      meta,
    });

    writePreviewHtml(outDir, meta);

    return {
      outputGlb,
      atlasPath,
      metaPath,
      backend: 'octahedral-puppeteer',
      frames,
      atlasSize,
      gutterPx: meta.gutterPx,
      alphaMode: meta.alphaMode,
      center: data.center,
      radius: data.radius,
    };
  } finally {
    try {
      rmSync(stagedGlb, { force: true });
      rmSync(bakeHtml, { force: true });
    } catch {
      // ignore
    }
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildBakerHtml({ atlasSize, frames, hemi, gutterPx }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>octa bake</title></head>
<body>
<canvas id="tile" width="256" height="256"></canvas>
<canvas id="atlas" width="${atlasSize}" height="${atlasSize}"></canvas>
<script>
window.__OCTA_API__ = { ready: false, error: null };
window.addEventListener('error', (e) => {
  if (!window.__OCTA_API__.ready) {
    window.__OCTA_API__.error = String(e.message || e.error || e);
  }
});
window.addEventListener('unhandledrejection', (e) => {
  if (!window.__OCTA_API__.ready) {
    window.__OCTA_API__.error = String(e.reason && e.reason.message ? e.reason.message : e.reason);
  }
});
</script>
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
const frames = ${frames};
const hemi = ${hemi ? 'true' : 'false'};
const gutterPx = ${gutterPx};
const tileSize = Math.floor(atlasSize / frames);
const innerSize = Math.max(1, tileSize - 2 * gutterPx);
const ss = 2; // 2× supersample per view → sharper impostor
const renderSize = tileSize * ss;

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
  // Avoid bright edge fringes when blitting WebGL → 2D atlas canvas.
  premultipliedAlpha: false,
});
renderer.setSize(renderSize, renderSize, false);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 1;

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 1.1));
scene.add(new THREE.HemisphereLight(0xf0f4ff, 0x889088, 0.95));
const sun = new THREE.DirectionalLight(0xfff5e8, 1.7);
sun.position.set(3, 6, 4);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xd0e0ff, 0.75);
fill.position.set(-4, 2, -2);
scene.add(fill);
const back = new THREE.DirectionalLight(0xffffff, 0.4);
back.position.set(0, 3, -5);
scene.add(back);

/**
 * KitBash ships metal=1 + near-black GlassBlack. Without IBL that bakes as a silhouette.
 * For impostors we want readable facade colors: dielectrics + sky-tinted glass.
 */
function prepareMaterialsForImpostorBake(root) {
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const list = Array.isArray(obj.material) ? obj.material : [obj.material];
    const next = list.map((mat) => {
      if (!mat) return mat;
      const name = (mat.name || obj.name || '').toLowerCase();
      const isGlass = /glass|window|curtainwall/.test(name);

      if (isGlass) {
        // Replace pitch-black glass with a sky reflection stand-in (impostor readability).
        return new THREE.MeshBasicMaterial({
          color: new THREE.Color(0xb4d0e8),
          map: null,
          transparent: true,
          opacity: 0.92,
          side: mat.side ?? THREE.FrontSide,
          depthWrite: true,
          toneMapped: false,
        });
      }

      const color = mat.color ? mat.color.clone() : new THREE.Color(0xffffff);
      color.multiplyScalar(1.55);
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

/** Expand opaque edge colors into transparent gutter ring (mip-bleed safe). */
function dilateTile(tx, ty) {
  if (gutterPx <= 0) return;
  const img = atlasCtx.getImageData(tx, ty, tileSize, tileSize);
  const w = tileSize;
  const h = tileSize;
  const data = img.data;
  for (let pass = 0; pass < gutterPx; pass++) {
    const copy = new Uint8ClampedArray(data);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (copy[i + 3] > 0) continue;
        let bestA = 0, br = 0, bg = 0, bb = 0;
        const nbs = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
        for (let n = 0; n < 4; n++) {
          const nx = nbs[n][0], ny = nbs[n][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = (ny * w + nx) * 4;
          if (copy[ni + 3] > bestA) {
            bestA = copy[ni + 3];
            br = copy[ni]; bg = copy[ni + 1]; bb = copy[ni + 2];
          }
        }
        if (bestA > 0) {
          data[i] = br; data[i + 1] = bg; data[i + 2] = bb; data[i + 3] = bestA;
        }
      }
    }
  }
  atlasCtx.putImageData(img, tx, ty);
}

function premultiplyAtlas() {
  const img = atlasCtx.getImageData(0, 0, atlasSize, atlasSize);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    d[i] = Math.round(d[i] * a);
    d[i + 1] = Math.round(d[i + 1] * a);
    d[i + 2] = Math.round(d[i + 2] * a);
  }
  atlasCtx.putImageData(img, 0, 0);
}

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 10000);

/** Hemi-octahedron: UV [0,1]² → direction (Y-up). Full octa if !hemi. */
function octaDecode(u, v, hemiMode) {
  const x = u * 2 - 1;
  const z = v * 2 - 1;
  let dir;
  if (hemiMode) {
    dir = new THREE.Vector3(x, 1.0 - Math.abs(x) - Math.abs(z), z);
  } else {
    dir = new THREE.Vector3(x, 1.0 - Math.abs(x) - Math.abs(z), z);
    if (dir.y < 0) {
      const ox = dir.x;
      dir.x = (1 - Math.abs(dir.z)) * Math.sign(ox || 1);
      dir.z = (1 - Math.abs(ox)) * Math.sign(dir.z || 1);
    }
  }
  return dir.normalize();
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

let center = null;
let size = null;
let radius = 0;

window.__OCTA_API__.ready = false;
window.__OCTA_API__.error = null;

try {
  console.log('[bake] loading model…');
  const gltf = await new GLTFLoader().loadAsync('/model.glb');
  prepareMaterialsForImpostorBake(gltf.scene);
  scene.add(gltf.scene);

  const box = new THREE.Box3().setFromObject(gltf.scene);
  size = new THREE.Vector3();
  center = new THREE.Vector3();
  box.getSize(size);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  center.copy(sphere.center);
  radius = Math.max(sphere.radius, 1e-4);
  // Epic-style: ortho frustum = sphere diameter (tile fills bounds).
  const ortho = radius * 2;

  camera.left = -ortho / 2;
  camera.right = ortho / 2;
  camera.top = ortho / 2;
  camera.bottom = -ortho / 2;
  camera.near = 0.05;
  camera.far = radius * 20;
  camera.updateProjectionMatrix();

  console.log('[bake] ready frames', frames, 'tile', tileSize, 'gutter', gutterPx, 'ss', ss, 'radius', radius.toFixed(3));

  window.__OCTA_API__.bakeRow = async function bakeRow(j) {
    for (let i = 0; i < frames; i++) {
      const u = (i + 0.5) / frames;
      const v = (j + 0.5) / frames;
      const dir = octaDecode(u, v, hemi);

      camera.position.copy(center).addScaledVector(dir, radius * 2.5);
      camera.up.set(0, 1, 0);
      if (Math.abs(dir.y) > 0.99) camera.up.set(0, 0, dir.y > 0 ? -1 : 1);
      camera.lookAt(center);

      renderer.render(scene, camera);

      const dx = i * tileSize;
      const dy = j * tileSize;
      atlasCtx.clearRect(dx, dy, tileSize, tileSize);
      atlasCtx.drawImage(
        tileCanvas, 0, 0, renderSize, renderSize,
        dx + gutterPx, dy + gutterPx, innerSize, innerSize,
      );
      dilateTile(dx, dy);
    }
    // Yield so Puppeteer / compositor can flush between rows
    await nextFrame();
  };

  window.__OCTA_API__.finish = function finish() {
    try {
      premultiplyAtlas();
      return {
        ok: true,
        atlas: atlasCanvas.toDataURL('image/png'),
        center: { x: center.x, y: center.y, z: center.z },
        size: { x: size.x, y: size.y, z: size.z },
        radius,
        frames,
        atlasSize,
        gutterPx,
        hemi,
        atlasLayout: 'j0_top',
        alphaMode: 'premultiplied',
      };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  };

  window.__OCTA_API__.ready = true;
} catch (err) {
  window.__OCTA_API__.ready = false;
  window.__OCTA_API__.error = String(err && err.message ? err.message : err);
}
</script>
</body></html>`;
}

async function buildBillboardGlb({ outputGlb, center, radius, atlasBytes, meta }) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('OctahedralImpostor');

  // Single camera-facing quad sized to bounding sphere diameter.
  // Runtime shader billboards it; in Blender it just looks like a flat atlas preview.
  const s = radius;
  const positions = new Float32Array([
    -s, -s, 0, s, -s, 0, s, s, 0, -s, s, 0,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

  const posAcc = doc
    .createAccessor('pos')
    .setType('VEC3')
    .setArray(positions)
    .setBuffer(buffer);
  const uvAcc = doc
    .createAccessor('uv')
    .setType('VEC2')
    .setArray(uvs)
    .setBuffer(buffer);
  const idxAcc = doc
    .createAccessor('idx')
    .setType('SCALAR')
    .setArray(indices)
    .setBuffer(buffer);

  const texture = doc
    .createTexture('octa_atlas')
    .setImage(atlasBytes)
    .setMimeType('image/png');

  const cutoff =
    typeof meta.alphaCutoff === 'number' ? meta.alphaCutoff : 0.35;
  const material = doc
    .createMaterial('OctaAtlasPreview')
    .setBaseColorTexture(texture)
    .setAlphaMode('MASK')
    .setAlphaCutoff(cutoff)
    .setDoubleSided(true)
    .setMetallicFactor(0)
    .setRoughnessFactor(1);

  const mesh = doc.createMesh('OctaBillboard');
  mesh.addPrimitive(
    doc
      .createPrimitive()
      .setAttribute('POSITION', posAcc)
      .setAttribute('TEXCOORD_0', uvAcc)
      .setIndices(idxAcc)
      .setMaterial(material)
      .setMode(4),
  );

  const node = doc
    .createNode('OctahedralImpostor')
    .setMesh(mesh)
    .setTranslation([center.x, center.y, center.z]);

  // Embed shader params for engines / Three.js helper
  node.setExtras({
    hpImpostor: meta,
  });
  doc.getRoot().getAsset().extras = {
    hpImpostor: meta,
  };

  scene.addChild(node);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  await io.write(outputGlb, doc);
  console.log(`  octahedral: wrote ${outputGlb} (preview quad + atlas)`);
}

function writePreviewHtml(outDir, meta) {
  const html = `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="utf-8"/>
  <title>Octahedral Impostor Preview</title>
  <style>
    html, body { margin: 0; height: 100%; background: #1a1a1a; color: #ddd; font-family: system-ui, sans-serif; }
    #c { display: block; width: 100%; height: 100%; }
    #hud { position: fixed; left: 12px; top: 12px; background: rgba(0,0,0,.65); padding: 10px 14px; border-radius: 8px; font-size: 13px; line-height: 1.45; max-width: 360px; }
    a { color: #8cf; }
  </style>
</head>
<body>
  <div id="hud">
    <b>Octahedral impostor</b> (hemi=${meta.hemi}, ${meta.frames}×${meta.frames}, gutter=${meta.gutterPx ?? 0}px)<br/>
    Otáčej myší — 3-frame barycentric blend z atlasu.<br/>
    <b>Oddál kameru</b> (kolečko) — zblízka je impostor vždy pixelovaný; ve hře je na dálku.<br/>
    Atlas: <a href="impostor_atlas.png" target="_blank">impostor_atlas.png</a> (${meta.alphaMode || 'straight'})
  </div>
  <canvas id="c"></canvas>
  <script type="importmap">
  {
    "imports": {
      "three": "https://unpkg.com/three@0.175.0/build/three.module.js",
      "three/addons/": "https://unpkg.com/three@0.175.0/examples/jsm/"
    }
  }
  </script>
  <script type="module">
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

  const meta = ${JSON.stringify(meta)};
  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x222228);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1e6);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  const c = meta.center;
  const R = meta.radius;
  controls.target.set(c.x, c.y, c.z);
  camera.position.set(c.x + R * 3, c.y + R * 1.2, c.z + R * 3);

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const grid = new THREE.GridHelper(R * 8, 20, 0x444444, 0x333333);
  grid.position.set(c.x, c.y - R, c.z);
  scene.add(grid);

  const loader = new THREE.TextureLoader();
  const bust = new URLSearchParams(location.search).get('t');
  const atlasUrl = bust
    ? \`./impostor_atlas.png?t=\${encodeURIComponent(bust)}\`
    : './impostor_atlas.png';
  const atlas = await loader.loadAsync(atlasUrl);
  atlas.colorSpace = THREE.SRGBColorSpace;
  // Must match baker: j=0 at TOP of PNG, V increases downward with j.
  atlas.flipY = false;
  atlas.magFilter = THREE.LinearFilter;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.generateMipmaps = true;

  const frames = meta.frames;
  const hemi = meta.hemi;
  const gutterPx = meta.gutterPx ?? 2;
  const atlasSize = meta.atlasSize || atlas.image.width;
  const alphaCutoff = typeof meta.alphaCutoff === 'number' ? meta.alphaCutoff : 0.35;

  const uniforms = {
    atlas: { value: atlas },
    frames: { value: frames },
    hemi: { value: hemi ? 1 : 0 },
    center: { value: new THREE.Vector3(c.x, c.y, c.z) },
    radius: { value: R },
    gutterPx: { value: gutterPx },
    atlasSize: { value: atlasSize },
    alphaCutoff: { value: alphaCutoff },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */\`
      uniform vec3 center;
      uniform float radius;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 camRight = vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0]);
        vec3 camUp    = vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]);
        // Quad +Y = camera up (roofs toward top of screen)
        vec3 world = center + camRight * position.x + camUp * position.y;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }
    \`,
    fragmentShader: /* glsl */\`
      uniform sampler2D atlas;
      uniform float frames;
      uniform float hemi;
      uniform vec3 center;
      uniform float gutterPx;
      uniform float atlasSize;
      uniform float alphaCutoff;
      varying vec2 vUv;

      vec2 octaEncode(vec3 n, float hemiMode) {
        n = normalize(n);
        if (hemiMode > 0.5) n.y = max(n.y, 0.001);
        n = normalize(n);
        float l1 = abs(n.x) + abs(n.y) + abs(n.z);
        vec2 f = vec2(n.x, n.z) / max(l1, 1e-5);
        if (hemiMode < 0.5 && n.y < 0.0) {
          f = (1.0 - abs(f.yx)) * sign(f);
        }
        return clamp(f * 0.5 + 0.5, 0.0, 1.0);
      }

      // Sample inside tile with gutter + half-texel inset (bilinear never crosses frames).
      // flipY=false, j=0 at top of PNG: feet at bottom of tile → 1-v inside cell
      vec4 sampleCell(vec2 cell, vec2 local) {
        float tileUv = 1.0 / frames;
        float pad = (gutterPx + 0.5) / max(atlasSize, 1.0);
        float inner = max(tileUv - 2.0 * pad, 1.0 / max(atlasSize, 1.0));
        vec2 lo = clamp(local, vec2(0.0), vec2(1.0));
        vec2 atlasUv = vec2(
          cell.x * tileUv + pad + lo.x * inner,
          cell.y * tileUv + pad + (1.0 - lo.y) * inner
        );
        return texture2D(atlas, atlasUv);
      }

      void main() {
        vec3 viewDir = normalize(cameraPosition - center);
        vec2 gridUv = octaEncode(viewDir, hemi);

        // Brucks / UE: 3 nearest frames + barycentric weights
        vec2 g = gridUv * frames - 0.5;
        vec2 g0 = floor(g);
        vec2 f = fract(g);
        vec2 lim = vec2(frames - 1.0);
        vec2 c1, c2, c3;
        vec3 w;
        if (f.x + f.y < 1.0) {
          c1 = clamp(g0, vec2(0.0), lim);
          c2 = clamp(g0 + vec2(1.0, 0.0), vec2(0.0), lim);
          c3 = clamp(g0 + vec2(0.0, 1.0), vec2(0.0), lim);
          w = vec3(1.0 - f.x - f.y, f.x, f.y);
        } else {
          c1 = clamp(g0 + vec2(1.0, 1.0), vec2(0.0), lim);
          c2 = clamp(g0 + vec2(1.0, 0.0), vec2(0.0), lim);
          c3 = clamp(g0 + vec2(0.0, 1.0), vec2(0.0), lim);
          w = vec3(f.x + f.y - 1.0, 1.0 - f.y, 1.0 - f.x);
        }

        vec2 local = vUv;
        vec4 color =
          w.x * sampleCell(c1, local) +
          w.y * sampleCell(c2, local) +
          w.z * sampleCell(c3, local);

        if (color.a < alphaCutoff) discard;
        gl_FragColor = color;
      }
    \`,
  });

  const geo = new THREE.PlaneGeometry(R * 2, R * 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(c.x, c.y, c.z);
  scene.add(mesh);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  (function tick() {
    requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  })();
  </script>
</body>
</html>`;
  writeFileSync(join(outDir, 'preview.html'), html);
  console.log(`  octahedral: preview → ${join(outDir, 'preview.html')}`);
}
