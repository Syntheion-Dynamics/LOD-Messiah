import { dedup, prune } from '@gltf-transform/functions';
import { createHash } from 'node:crypto';

/**
 * Merge materials that share the same texture set. Keeps KitBash tiling UVs —
 * no mesh join, no rebake.
 *
 * @param {import('@gltf-transform/core').Document} document
 * @returns {Promise<{ materialsBefore: number, materialsAfter: number, texturesBefore: number, texturesAfter: number, merged: number }>}
 */
export async function mergeMaterials(document) {
  const root = document.getRoot();
  const materialsBefore = root.listMaterials().length;
  const texturesBefore = root.listTextures().length;

  // First collapse identical texture image blobs so material keys match.
  await document.transform(dedup());

  const keyToCanonical = new Map();
  let merged = 0;

  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (!mat) continue;
      const key = materialKey(mat);
      let canonical = keyToCanonical.get(key);
      if (!canonical) {
        keyToCanonical.set(key, mat);
        continue;
      }
      if (canonical !== mat) {
        prim.setMaterial(canonical);
        merged += 1;
      }
    }
  }

  await document.transform(prune());

  return {
    materialsBefore,
    materialsAfter: root.listMaterials().length,
    texturesBefore,
    texturesAfter: root.listTextures().length,
    merged,
  };
}

/**
 * @param {import('@gltf-transform/core').Material} mat
 */
function materialKey(mat) {
  const parts = [
    texKey(mat.getBaseColorTexture()),
    texKey(mat.getNormalTexture()),
    texKey(mat.getMetallicRoughnessTexture()),
    texKey(mat.getOcclusionTexture()),
    texKey(mat.getEmissiveTexture()),
    // Factor fallbacks when no textures (color-only materials)
    factorKey(mat.getBaseColorFactor()),
    numKey(mat.getMetallicFactor()),
    numKey(mat.getRoughnessFactor()),
    factorKey(mat.getEmissiveFactor()),
    mat.getAlphaMode() || 'OPAQUE',
    numKey(mat.getAlphaCutoff()),
    mat.getDoubleSided() ? '1' : '0',
  ];
  return parts.join('|');
}

/**
 * @param {import('@gltf-transform/core').Texture | null} tex
 */
function texKey(tex) {
  if (!tex) return '-';
  const img = tex.getImage();
  if (!img || img.byteLength === 0) {
    return `empty:${tex.getURI() || tex.getName() || ''}`;
  }
  return createHash('sha1').update(img).digest('hex').slice(0, 16);
}

function factorKey(arr) {
  if (!arr) return '-';
  return Array.from(arr)
    .map((v) => Number(v).toFixed(4))
    .join(',');
}

function numKey(n) {
  return n == null ? '-' : Number(n).toFixed(4);
}
