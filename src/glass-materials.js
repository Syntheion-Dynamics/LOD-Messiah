/**
 * Detect glass / window / emissive facade materials for LOD protect paths.
 * Name heuristic matches impostor bake (octahedral.js); emissive catches night windows.
 *
 * @param {import('@gltf-transform/core').Material | null} mat
 * @returns {boolean}
 */
export function isGlassOrEmissiveMaterial(mat) {
  if (!mat) return false;

  const name = (mat.getName() || '').toLowerCase();
  if (/glass|window|curtainwall/.test(name)) return true;

  if (mat.getEmissiveTexture()) return true;

  const [r, g, b] = mat.getEmissiveFactor() || [0, 0, 0];
  return r + g + b > 1e-4;
}

/**
 * Count triangles on primitives whose material is glass/emissive.
 * @param {import('@gltf-transform/core').Document} document
 * @returns {{ tris: number, prims: number, materials: string[] }}
 */
export function countGlassTris(document) {
  let tris = 0;
  let prims = 0;
  const names = new Set();

  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const mat = prim.getMaterial();
      if (!isGlassOrEmissiveMaterial(mat)) continue;
      prims += 1;
      if (mat?.getName()) names.add(mat.getName());
      const indices = prim.getIndices();
      if (indices) {
        tris += Math.floor(indices.getCount() / 3);
      } else {
        const pos = prim.getAttribute('POSITION');
        if (pos) tris += Math.floor(pos.getCount() / 3);
      }
    }
  }

  return { tris, prims, materials: [...names].sort() };
}
