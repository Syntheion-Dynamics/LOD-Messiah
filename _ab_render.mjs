import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import puppeteer from 'puppeteer';

const files = process.argv.slice(2); // glb paths relative to cwd
const ROOT = process.cwd();
const server = createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
  const full = join(ROOT, p);
  if (!existsSync(full)) { res.writeHead(404); res.end(); return; }
  const mime = extname(full) === '.js' ? 'text/javascript' : extname(full) === '.html' ? 'text/html' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime });
  res.end(readFileSync(full));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const html = `<!doctype html><body style="margin:0"><script type="importmap">
{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}
</script><script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(1000, 1000); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x222228);
window.renderGlb = async (url) => {
  const gltf = await new GLTFLoader().loadAsync(url);
  const obj = gltf.scene;
  obj.traverse(n => { if (n.isMesh) n.material = new THREE.MeshNormalMaterial({ flatShading: true }); });
  scene.clear(); scene.add(obj);
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const d = Math.max(s.x, s.y, s.z);
  const cam = new THREE.PerspectiveCamera(40, 1, d/100, d*10);
  cam.position.set(c.x + d*0.9, c.y + d*0.55, c.z + d*0.9); cam.lookAt(c);
  renderer.render(scene, cam);
  return renderer.domElement.toDataURL('image/png');
};
window.ready = true;
</script></body>`;
writeFileSync('_test_lodfix/_render.html', html);

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('PAGE ERROR:', e.message));
await page.goto(`http://127.0.0.1:${port}/_test_lodfix/_render.html`);
await page.waitForFunction('window.ready === true', { timeout: 30000 });
page.setDefaultTimeout(300000);
for (const f of files) {
  const url = '/' + f.split('\\').join('/');
  try {
    const dataUrl = await page.evaluate((u) => window.renderGlb(u), url);
    const out = '_test_lodfix/' + url.slice(1).split('/').join('_').replace('.glb', '') + '.png';
    writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('rendered', out);
  } catch (e) { console.error('FAIL', f, e.message); }
}
await browser.close(); server.close();
