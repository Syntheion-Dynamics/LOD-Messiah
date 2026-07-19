import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, flatten, join } from '@gltf-transform/functions';
import { permissiveSimplify } from './src/permissive-simplify.js';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
function stripTex(doc){ for (const t of doc.getRoot().listTextures()) t.dispose(); }
const src = process.argv[2];
const configs = [
  ['new_lod1', 0.3, 0.02, 0.01, true],
  ['new_lod2_protect_e012', 0.1, 0.12, 0.02, true],
  ['new_lod2_noprot_e008', 0.1, 0.08, 0.02, false],
];
for (const [name, ratio, error, pruneError, protectUv] of configs) {
  const doc = await io.read(src);
  await doc.transform(dedup(), flatten(), join());
  await permissiveSimplify(doc, { ratio, error, pruneError, protectUv });
  stripTex(doc);
  await io.write(`_test_lodfix/${name}.glb`, doc);
  console.log(`wrote ${name}.glb`);
}
