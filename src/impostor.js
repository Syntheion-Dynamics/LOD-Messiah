/**
 * AABB box impostor baker (4 sides + optional top).
 * Prefers Blender when available; otherwise Puppeteer + Three.js via local HTTP.
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  copyFileSync,
} from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { createServer } from 'node:http';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { spawnSync } from 'node:child_process';
import { resolveBlender, ROOT } from './convert.js';
import { generateOctahedralImpostor } from './octahedral.js';

/**
 * @param {object} options
 * @param {string} options.inputGlb
 * @param {string} options.outputGlb
 * @param {string} options.facesDir
 * @param {number} [options.resolution]
 * @param {boolean} [options.includeTop]
 * @param {string|null} [options.blender]
 * @param {'octahedral'|'box'} [options.mode]
 * @param {number} [options.frames]
 * @param {string} [options.outDir]
 * @param {string} [options.stageDir]
 */
export async function generateImpostor(options) {
  const mode = options.mode || 'octahedral';

  if (mode === 'octahedral') {
    const outDir = options.outDir || dirname(options.outputGlb);
    console.log(
      `  impostor: octahedral hemi bake (${options.resolution || 4096}px, ${(options.frames || 12)}×${(options.frames || 12)})`,
    );
    return generateOctahedralImpostor({
      inputGlb: options.inputGlb,
      outputGlb: options.outputGlb,
      outDir,
      stageDir: options.stageDir || outDir,
      atlasSize: options.resolution || 4096,
      frames: options.frames || 12,
      hemi: true,
    });
  }

  // Legacy AABB box (4 planes) — looks broken in Blender without face culling
  mkdirSync(options.facesDir, { recursive: true });
  mkdirSync(dirname(options.outputGlb), { recursive: true });

  const blenderBin = resolveBlender(options.blender);
  if (blenderBin) {
    console.log(`  impostor: Blender box bake (${options.resolution || 512}px)`);
    return runBlenderImpostor({
      blender: blenderBin,
      inputGlb: options.inputGlb,
      outputGlb: options.outputGlb,
      facesDir: options.facesDir,
      resolution: options.resolution || 512,
      includeTop: !!options.includeTop,
    });
  }

  console.log(`  impostor: Puppeteer box bake (${options.resolution || 512}px)`);
  return runPuppeteerImpostor({
    inputGlb: options.inputGlb,
    outputGlb: options.outputGlb,
    facesDir: options.facesDir,
    resolution: options.resolution || 512,
    includeTop: !!options.includeTop,
  });
}

function runBlenderImpostor({
  blender,
  inputGlb,
  outputGlb,
  facesDir,
  resolution,
  includeTop,
}) {
  const script = join(ROOT, 'scripts', 'blender_impostor.py');
  const args = [
    '--background',
    '--python',
    script,
    '--',
    '--input',
    inputGlb,
    '--output',
    outputGlb,
    '--faces-dir',
    facesDir,
    '--resolution',
    String(resolution),
  ];
  if (includeTop) args.push('--include-top');

  const r = spawnSync(blender, args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (r.status !== 0 || !existsSync(outputGlb)) {
    throw new Error(
      `Blender impostor failed (${r.status}):\n${r.stderr || r.stdout || 'no output'}`,
    );
  }
  return { outputGlb, facesDir, backend: 'blender' };
}

async function runPuppeteerImpostor({
  inputGlb,
  outputGlb,
  facesDir,
  resolution,
  includeTop,
}) {
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer')).default;
  } catch {
    throw new Error(
      'Impostor needs Blender or the "puppeteer" package. Run: npm install puppeteer',
    );
  }

  const threeRoot = join(ROOT, 'node_modules', 'three');
  if (!existsSync(join(threeRoot, 'build', 'three.module.js'))) {
    throw new Error('three package missing — npm install three');
  }

  // Stage GLB next to served HTML
  const stagedGlb = join(facesDir, 'source.glb');
  copyFileSync(inputGlb, stagedGlb);

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>impostor</title></head>
<body style="margin:0;background:transparent">
<canvas id="c" width="${resolution}" height="${resolution}"></canvas>
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

const res = ${resolution};
const includeTop = ${includeTop ? 'true' : 'false'};
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({
  canvas, alpha: true, antialias: true, preserveDrawingBuffer: true
});
renderer.setSize(res, res, false);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(4, 8, 5);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.45);
fill.position.set(-5, 2, -3);
scene.add(fill);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);

try {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync('/model.glb');
  scene.add(gltf.scene);

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  size.x = Math.max(size.x, 1e-3);
  size.y = Math.max(size.y, 1e-3);
  size.z = Math.max(size.z, 1e-3);

  const margin = 1.02;
  const faces = [
    { name: 'front', dir: new THREE.Vector3(0, 0, 1) },
    { name: 'back', dir: new THREE.Vector3(0, 0, -1) },
    { name: 'left', dir: new THREE.Vector3(-1, 0, 0) },
    { name: 'right', dir: new THREE.Vector3(1, 0, 0) },
  ];
  if (includeTop) faces.push({ name: 'top', dir: new THREE.Vector3(0, 1, 0) });

  const results = {};
  for (const face of faces) {
    const dir = face.dir.clone().normalize();
    let ortho;
    if (Math.abs(dir.y) > 0.9) ortho = Math.max(size.x, size.z) * margin;
    else if (Math.abs(dir.x) > 0.9) ortho = Math.max(size.y, size.z) * margin;
    else ortho = Math.max(size.x, size.y) * margin;

    camera.left = -ortho / 2;
    camera.right = ortho / 2;
    camera.top = ortho / 2;
    camera.bottom = -ortho / 2;
    camera.near = 0.1;
    camera.far = Math.max(size.x, size.y, size.z) * 20;
    camera.updateProjectionMatrix();

    const dist = Math.max(size.x, size.y, size.z) * 2;
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(center);

    renderer.render(scene, camera);
    results[face.name] = canvas.toDataURL('image/png');
  }

  window.__IMPOSTOR__ = {
    ok: true,
    faces: results,
    center: { x: center.x, y: center.y, z: center.z },
    size: { x: size.x, y: size.y, z: size.z },
  };
} catch (err) {
  window.__IMPOSTOR__ = { ok: false, error: String(err && err.message ? err.message : err) };
}
</script>
</body></html>`;

  writeFileSync(join(facesDir, 'index.html'), html);

  const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.glb': 'model/gltf-binary',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.wasm': 'application/wasm',
  };

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      let filePath;
      if (url.pathname === '/' || url.pathname === '/index.html') {
        filePath = join(facesDir, 'index.html');
      } else if (url.pathname === '/model.glb') {
        filePath = stagedGlb;
      } else if (url.pathname.startsWith('/vendor/three/')) {
        filePath = join(threeRoot, url.pathname.slice('/vendor/three/'.length));
      } else {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('missing ' + filePath);
        return;
      }
      const body = readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': mime[extname(filePath)] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
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
    headless: true,
    args: [
      '--use-gl=angle',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--no-sandbox',
      '--disable-web-security',
    ],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(180000);
    page.on('pageerror', (err) => console.warn(`  impostor pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.warn(`  impostor console: ${msg.text()}`);
    });

    await page.setViewport({
      width: resolution,
      height: resolution,
      deviceScaleFactor: 1,
    });

    await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: 'networkidle0',
      timeout: 180000,
    });

    await page.waitForFunction(
      () => window.__IMPOSTOR__ && (window.__IMPOSTOR__.ok === true || window.__IMPOSTOR__.ok === false),
      { timeout: 180000 },
    );

    const data = await page.evaluate(() => window.__IMPOSTOR__);
    if (!data.ok) {
      throw new Error(`Impostor render failed in browser: ${data.error}`);
    }

    const faceFiles = {};
    for (const [name, dataUrl] of Object.entries(data.faces)) {
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      const path = join(facesDir, `${name}.png`);
      writeFileSync(path, buf);
      faceFiles[name] = { path, bytes: buf };
      console.log(`  impostor: wrote ${name}.png (${(buf.length / 1024).toFixed(1)} KB)`);
    }

    await buildBoxGlb({
      outputGlb,
      center: data.center,
      size: data.size,
      faceFiles,
      includeTop,
    });

    // Cleanup staging (keep only face PNGs)
    try {
      const { rmSync } = await import('node:fs');
      rmSync(stagedGlb, { force: true });
      rmSync(join(facesDir, 'index.html'), { force: true });
    } catch {
      // ignore
    }

    return {
      outputGlb,
      facesDir,
      backend: 'puppeteer',
      center: data.center,
      size: data.size,
    };
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Build a multi-material AABB box GLB from face PNGs.
 * Three.js Y-up: front=+Z, back=-Z, left=-X, right=+X, top=+Y
 */
async function buildBoxGlb({ outputGlb, center, size, faceFiles, includeTop }) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Impostor');
  const rootNode = doc.createNode('ImpostorBox').setTranslation([
    center.x,
    center.y,
    center.z,
  ]);
  scene.addChild(rootNode);

  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;

  /** @type {Array<{name:string, positions:number[], indices:number[]}>} */
  const faceGeom = [
    {
      name: 'front',
      positions: [-hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz],
      indices: [0, 1, 2, 0, 2, 3],
    },
    {
      name: 'back',
      positions: [hx, -hy, -hz, -hx, -hy, -hz, -hx, hy, -hz, hx, hy, -hz],
      indices: [0, 1, 2, 0, 2, 3],
    },
    {
      name: 'left',
      positions: [-hx, -hy, -hz, -hx, -hy, hz, -hx, hy, hz, -hx, hy, -hz],
      indices: [0, 1, 2, 0, 2, 3],
    },
    {
      name: 'right',
      positions: [hx, -hy, hz, hx, -hy, -hz, hx, hy, -hz, hx, hy, hz],
      indices: [0, 1, 2, 0, 2, 3],
    },
  ];
  if (includeTop && faceFiles.top) {
    faceGeom.push({
      name: 'top',
      positions: [-hx, hy, hz, hx, hy, hz, hx, hy, -hz, -hx, hy, -hz],
      indices: [0, 1, 2, 0, 2, 3],
    });
  }

  const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  const mesh = doc.createMesh('ImpostorMesh');

  for (const face of faceGeom) {
    const file = faceFiles[face.name];
    if (!file) continue;

    const texture = doc
      .createTexture(face.name)
      .setImage(file.bytes)
      .setMimeType('image/png');

    const material = doc
      .createMaterial(`mat_${face.name}`)
      .setBaseColorTexture(texture)
      .setAlphaMode('MASK')
      .setAlphaCutoff(0.4)
      .setDoubleSided(true)
      .setMetallicFactor(0)
      .setRoughnessFactor(1);

    const posAcc = doc
      .createAccessor(`${face.name}_pos`)
      .setType('VEC3')
      .setArray(new Float32Array(face.positions))
      .setBuffer(buffer);

    const uvAcc = doc
      .createAccessor(`${face.name}_uv`)
      .setType('VEC2')
      .setArray(new Float32Array(uvs))
      .setBuffer(buffer);

    const idxAcc = doc
      .createAccessor(`${face.name}_idx`)
      .setType('SCALAR')
      .setArray(new Uint16Array(face.indices))
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
  console.log(`  impostor: wrote ${outputGlb}`);
}
