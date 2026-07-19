import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
const texs = root.listTextures();
let total = 0;
const rows = texs.map(t => {
  const img = t.getImage();
  const size = img ? img.byteLength : 0;
  total += size;
  const s = t.getSize() || [0,0];
  return { name: t.getName()||'(unnamed)', mime: t.getMimeType(), px: `${s[0]}x${s[1]}`, mb: (size/1048576).toFixed(1) };
});
rows.sort((a,b)=>parseFloat(b.mb)-parseFloat(a.mb));
console.log(`textures: ${texs.length}, total texture bytes: ${(total/1048576).toFixed(1)} MB`);
for (const r of rows.slice(0,15)) console.log(`  ${r.mb.padStart(7)} MB  ${r.px.padStart(11)}  ${r.mime}  ${r.name}`);
let tris=0, prims=0;
for (const m of root.listMeshes()) for (const p of m.listPrimitives()){ prims++; const idx=p.getIndices(); tris += idx? idx.getCount()/3 : (p.getAttribute('POSITION')?.getCount()||0)/3; }
console.log(`meshes: ${root.listMeshes().length}, primitives: ${prims}, triangles: ${Math.round(tris).toLocaleString()}, materials: ${root.listMaterials().length}`);
