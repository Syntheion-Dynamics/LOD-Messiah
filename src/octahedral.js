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
 * @param {string} options.outDir
 * @param {number} [options.atlasSize] atlas edge px (default 4096)
 * @param {number} [options.frames] grid size (default 12 → 144 views)
 * @param {boolean} [options.hemi] hemi-octahedron for buildings (default true)
 */
export async function generateOctahedralImpostor(options) {
  const {
    inputGlb,
    outputGlb,
    outDir,
    atlasSize = 4096,
    frames = 12,
    hemi = true,
  } = options;

  mkdirSync(outDir, { recursive: true });
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

  const stagedGlb = join(outDir, '_source.glb');
  copyFileSync(inputGlb, stagedGlb);

  const html = buildBakerHtml({ atlasSize, frames, hemi });
  writeFileSync(join(outDir, '_bake.html'), html);

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
        filePath = join(outDir, '_bake.html');
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
    page.setDefaultTimeout(300000);
    page.on('pageerror', (err) =>
      console.warn(`  octahedral pageerror: ${err.message}`),
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
      timeout: 300000,
    });

    await page.waitForFunction(
      () =>
        window.__OCTA__ &&
        (window.__OCTA__.ok === true || window.__OCTA__.ok === false),
      { timeout: 300000 },
    );

    const data = await page.evaluate(() => window.__OCTA__);
    if (!data.ok) {
      throw new Error(`Octahedral bake failed: ${data.error}`);
    }

    const atlasB64 = data.atlas.replace(/^data:image\/png;base64,/, '');
    const atlasBytes = Buffer.from(atlasB64, 'base64');
    const atlasPath = join(outDir, 'impostor_atlas.png');
    writeFileSync(atlasPath, atlasBytes);
    console.log(
      `  octahedral: atlas ${atlasSize}px / ${frames}×${frames} (${(atlasBytes.length / 1024).toFixed(0)} KB)`,
    );

    const meta = {
      type: 'octahedral',
      hemi: !!hemi,
      frames,
      atlasSize,
      atlas: 'impostor_atlas.png',
      center: data.center,
      radius: data.radius,
      size: data.size,
      generatedAt: new Date().toISOString(),
      note: 'Open preview.html in a browser (or use runtime/octahedral-impostor.js). Blender cannot view-dependently sample this atlas.',
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

    // Cleanup staging
    try {
      rmSync(stagedGlb, { force: true });
      rmSync(join(outDir, '_bake.html'), { force: true });
    } catch {
      // ignore
    }

    // Write self-contained preview next to outputs
    writePreviewHtml(outDir, meta);

    return {
      outputGlb,
      atlasPath,
      metaPath,
      backend: 'octahedral-puppeteer',
      frames,
      atlasSize,
      center: data.center,
      radius: data.radius,
    };
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildBakerHtml({ atlasSize, frames, hemi }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>octa bake</title></head>
<body>
<canvas id="tile" width="256" height="256"></canvas>
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
const frames = ${frames};
const hemi = ${hemi ? 'true' : 'false'};
const tileSize = Math.floor(atlasSize / frames);

const tileCanvas = document.getElementById('tile');
tileCanvas.width = tileSize;
tileCanvas.height = tileSize;
const atlasCanvas = document.getElementById('atlas');
const atlasCtx = atlasCanvas.getContext('2d');
atlasCtx.clearRect(0, 0, atlasSize, atlasSize);

const renderer = new THREE.WebGLRenderer({
  canvas: tileCanvas, alpha: true, antialias: true, preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setSize(tileSize, tileSize, false);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 0.75));
scene.add(new THREE.HemisphereLight(0xddeeff, 0x445566, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.45);
sun.position.set(3, 6, 4);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xfff2e0, 0.65);
fill.position.set(-4, 2, -2);
scene.add(fill);
const back = new THREE.DirectionalLight(0xffffff, 0.35);
back.position.set(0, 3, -5);
scene.add(back);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 10000);

/** Hemi-octahedron: UV [0,1]² → direction (Y-up). Full octa if !hemi. */
function octaDecode(u, v, hemiMode) {
  const x = u * 2 - 1;
  const z = v * 2 - 1;
  let dir;
  if (hemiMode) {
    // Upper hemisphere: y = 1 - |x| - |z|
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

try {
  console.log('[bake] loading model…');
  const gltf = await new GLTFLoader().loadAsync('/model.glb');
  scene.add(gltf.scene);

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const radius = Math.max(size.x, size.y, size.z) * 0.5 * Math.SQRT2;
  const ortho = radius * 2.05;

  camera.left = -ortho / 2;
  camera.right = ortho / 2;
  camera.top = ortho / 2;
  camera.bottom = -ortho / 2;
  camera.near = 0.05;
  camera.far = radius * 20;
  camera.updateProjectionMatrix();

  console.log('[bake] frames', frames, 'tile', tileSize);

  for (let j = 0; j < frames; j++) {
    for (let i = 0; i < frames; i++) {
      const u = (i + 0.5) / frames;
      const v = (j + 0.5) / frames;
      const dir = octaDecode(u, v, hemi);

      camera.position.copy(center).addScaledVector(dir, radius * 2.5);
      camera.up.set(0, 1, 0);
      // Avoid gimbal when looking straight down/up
      if (Math.abs(dir.y) > 0.99) camera.up.set(0, 0, dir.y > 0 ? -1 : 1);
      camera.lookAt(center);

      renderer.render(scene, camera);

      // Atlas layout: cell (i,j) at (i,j), j=0 at TOP of PNG.
      // Preview loads with flipY=false so V+ goes down the image with j.
      const dx = i * tileSize;
      const dy = j * tileSize;
      atlasCtx.drawImage(tileCanvas, dx, dy, tileSize, tileSize);
    }
    if (j % 2 === 0) console.log('[bake] row', j + 1, '/', frames);
  }

  window.__OCTA__ = {
    ok: true,
    atlas: atlasCanvas.toDataURL('image/png'),
    center: { x: center.x, y: center.y, z: center.z },
    size: { x: size.x, y: size.y, z: size.z },
    radius,
    frames,
    atlasSize,
    hemi,
    atlasLayout: 'j0_top', // cell (i,j) at (i,j); load texture with flipY=false
  };
  console.log('[bake] done');
} catch (err) {
  window.__OCTA__ = { ok: false, error: String(err && err.message ? err.message : err) };
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

  const material = doc
    .createMaterial('OctaAtlasPreview')
    .setBaseColorTexture(texture)
    .setAlphaMode('MASK')
    .setAlphaCutoff(0.35)
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
    <b>Octahedral impostor</b> (hemi=${meta.hemi}, ${meta.frames}×${meta.frames})<br/>
    Otáčej myší — shader vybírá pohled z atlasu.<br/>
    Blender tohle neumí; tento preview = engine chování.<br/>
    Atlas: <a href="impostor_atlas.png" target="_blank">impostor_atlas.png</a>
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
  const atlas = await loader.loadAsync('./impostor_atlas.png');
  atlas.colorSpace = THREE.SRGBColorSpace;
  // Must match baker: j=0 at TOP of PNG, V increases downward with j.
  atlas.flipY = false;
  atlas.magFilter = THREE.LinearFilter;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.generateMipmaps = true;

  const frames = meta.frames;
  const hemi = meta.hemi;

  const uniforms = {
    atlas: { value: atlas },
    frames: { value: frames },
    hemi: { value: hemi ? 1 : 0 },
    center: { value: new THREE.Vector3(c.x, c.y, c.z) },
    radius: { value: R },
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

      // flipY=false, j=0 at top of PNG: feet at bottom of tile → 1-v inside cell
      vec4 sampleCell(vec2 cell, vec2 local) {
        vec2 atlasUv = vec2(
          (cell.x + local.x) / frames,
          (cell.y + (1.0 - local.y)) / frames
        );
        return texture2D(atlas, atlasUv);
      }

      void main() {
        // Bake camera sat on +viewDir; match that here
        vec3 viewDir = normalize(cameraPosition - center);
        vec2 gridUv = octaEncode(viewDir, hemi);

        // Soft 2×2 blend between neighboring views (less "slideshow" pops)
        vec2 g = gridUv * frames - 0.5;
        vec2 g0 = floor(g);
        vec2 f = fract(g);
        vec2 c00 = clamp(g0, vec2(0.0), vec2(frames - 1.0));
        vec2 c10 = clamp(g0 + vec2(1.0, 0.0), vec2(0.0), vec2(frames - 1.0));
        vec2 c01 = clamp(g0 + vec2(0.0, 1.0), vec2(0.0), vec2(frames - 1.0));
        vec2 c11 = clamp(g0 + vec2(1.0, 1.0), vec2(0.0), vec2(frames - 1.0));

        vec2 local = vUv;
        vec4 s00 = sampleCell(c00, local);
        vec4 s10 = sampleCell(c10, local);
        vec4 s01 = sampleCell(c01, local);
        vec4 s11 = sampleCell(c11, local);
        vec4 color = mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);

        if (color.a < 0.35) discard;
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
