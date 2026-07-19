import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, flatten, join } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { permissiveSimplify } from './src/permissive-simplify.js';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

function analyze(doc) {
  let tris = 0;
  const prims = [];
  // component count via union-find over position-welded verts
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices()?.getArray();
      const pos = prim.getAttribute('POSITION')?.getArray();
      if (!idx || !pos) continue;
      tris += idx.length / 3;
      prims.push({ idx, pos });
    }
  }
  // global weld across prims
  const keyMap = new Map();
  const nodes = [];
  const parent = [];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const vid = (pos, i) => {
    const k = `${Math.round(pos[i*3]*1e4)},${Math.round(pos[i*3+1]*1e4)},${Math.round(pos[i*3+2]*1e4)}`;
    let id = keyMap.get(k);
    if (id === undefined) { id = nodes.length; nodes.push(0); parent.push(id); keyMap.set(k, id); }
    return id;
  };
  for (const { idx, pos } of prims) {
    for (let t = 0; t < idx.length; t += 3) {
      const a = vid(pos, idx[t]), b = vid(pos, idx[t+1]), c = vid(pos, idx[t+2]);
      uni(a, b); uni(a, c);
    }
  }
  const roots = new Set();
  for (let i = 0; i < parent.length; i++) roots.add(find(i));
  return { tris: Math.round(tris), components: roots.size };
}

const src = process.argv[2];
console.log('loading source...');
const base = await io.read(src);
await base.transform(dedup(), flatten(), join());
const s = analyze(base);
console.log(`SOURCE          : ${s.tris.toLocaleString()} tris, ${s.components} components`);

for (const [label, ratio, error] of [['NEW LOD1 (e=0.02)', 0.3, 0.02], ['NEW LOD2 (e=0.04)', 0.1, 0.04]]) {
  const doc = await io.read(src);
  await doc.transform(dedup(), flatten(), join());
  await MeshoptSimplifier.ready;
  const r = await permissiveSimplify(doc, { ratio, error });
  const a = analyze(doc);
  console.log(`${label}: ${a.tris.toLocaleString()} tris (target ${(ratio*100)}%, achieved ${(100*a.tris/s.tris).toFixed(1)}%), ${a.components} components`);
}

for (const [label, file] of [['OLD lod1.glb', process.argv[3]], ['OLD lod2.glb', process.argv[4]]]) {
  if (!file) continue;
  const doc = await io.read(file);
  const a = analyze(doc);
  console.log(`${label}     : ${a.tris.toLocaleString()} tris (${(100*a.tris/s.tris).toFixed(1)}%), ${a.components} components`);
}
