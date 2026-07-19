import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, flatten, join } from '@gltf-transform/functions';
import { permissiveSimplify } from './src/permissive-simplify.js';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
function analyze(doc) {
  let tris = 0; const prims = [];
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices()?.getArray(); const pos = prim.getAttribute('POSITION')?.getArray();
    if (!idx || !pos) continue; tris += idx.length / 3; prims.push({ idx, pos });
  }
  const keyMap = new Map(); const parent = [];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const vid = (pos, i) => { const k = `${Math.round(pos[i*3]*1e4)},${Math.round(pos[i*3+1]*1e4)},${Math.round(pos[i*3+2]*1e4)}`;
    let id = keyMap.get(k); if (id === undefined) { id = parent.length; parent.push(id); keyMap.set(k, id); } return id; };
  for (const { idx, pos } of prims) for (let t = 0; t < idx.length; t += 3) { const a = vid(pos, idx[t]), b = vid(pos, idx[t+1]), c = vid(pos, idx[t+2]); uni(a, b); uni(a, c); }
  const roots = new Set(); for (let i = 0; i < parent.length; i++) roots.add(find(i));
  return { tris: Math.round(tris), components: roots.size };
}
const src = process.argv[2];
const configs = [
  ['LOD2 e=0.06 p=0.01', 0.1, 0.06, 0.01],
  ['LOD2 e=0.08 p=0.01', 0.1, 0.08, 0.01],
  ['LOD2 e=0.12 p=0.02', 0.1, 0.12, 0.02],
];
for (const [label, ratio, error, pruneError] of configs) {
  const doc = await io.read(src);
  await doc.transform(dedup(), flatten(), join());
  await permissiveSimplify(doc, { ratio, error, pruneError });
  const a = analyze(doc);
  console.log(`${label}: ${a.tris.toLocaleString()} tris (${(100*a.tris/319242).toFixed(1)}%), ${a.components} components`);
}
