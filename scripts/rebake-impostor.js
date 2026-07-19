#!/usr/bin/env node
/** Quick impostor-only rebake from a PNG-textured GLB (skips LOD/KTX2). */
import { resolve } from 'node:path';
import { generateOctahedralImpostor } from '../legacy/impostor/octahedral.js';

const input = resolve(process.argv[2] || '');
const outDir = resolve(process.argv[3] || './output/_impostor_tmp');
const atlasSize = Number(process.argv[4] || 4096);
const frames = Number(process.argv[5] || 12);

if (!input) {
  console.error(
    'Usage: node scripts/rebake-impostor.js <input.glb> <outDir> [atlasSize=4096] [frames=12]',
  );
  process.exit(1);
}

const result = await generateOctahedralImpostor({
  inputGlb: input,
  outputGlb: resolve(outDir, 'impostor.glb'),
  outDir,
  atlasSize,
  frames,
  hemi: true,
});
console.log('OK', result.atlasPath || outDir);
