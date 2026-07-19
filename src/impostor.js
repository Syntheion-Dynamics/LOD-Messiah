/**
 * Thin re-export of the legacy impostor bakers (octahedral / AABB box).
 * Default cook path no longer bakes impostors — use LOD3 boxcards instead.
 * Opt-in: `--impostor` / `npm run rebake:impostors`.
 */
export { generateImpostor } from '../legacy/impostor/impostor.js';
export { generateOctahedralImpostor } from '../legacy/impostor/octahedral.js';
