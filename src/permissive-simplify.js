import { MeshoptSimplifier } from 'meshoptimizer';
import { isGlassOrEmissiveMaterial } from './glass-materials.js';

const TRIANGLES = 4;
/** meshopt_SimplifyVertex_Protect — keep UV seams under Permissive mode */
const VERTEX_PROTECT = 2;

/**
 * Attribute-aware Permissive simplify (meshopt recipe).
 * Does NOT weld-average UVs — Protects UV discontinuities at shared positions.
 *
 * @param {import('@gltf-transform/core').Document} document
 * @param {{ ratio: number, error?: number, pruneError?: number, protectUv?: boolean, protectGlass?: boolean }} options
 */
export async function permissiveSimplify(document, options) {
  const {
    ratio,
    error = 0.01,
    pruneError = 0.01,
    protectUv = true,
    protectGlass = false,
  } = options;
  await MeshoptSimplifier.ready;

  const logger = document.getLogger();
  let primCount = 0;
  let srcTris = 0;
  let dstTris = 0;
  let skippedPrims = 0;
  let skippedTris = 0;

  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== TRIANGLES) continue;
      const before = countTris(prim);
      srcTris += before;

      if (protectGlass && isGlassOrEmissiveMaterial(prim.getMaterial())) {
        skippedPrims += 1;
        skippedTris += before;
        dstTris += before;
        primCount += 1;
        continue;
      }

      simplifyPrimitive(document, prim, ratio, error, pruneError, protectUv);
      const after = countTris(prim);
      dstTris += after;
      primCount += 1;
      if (before > 0) {
        logger.debug?.(
          `permissiveSimplify: ${before} → ${after} tris (ratio ${(after / before).toFixed(3)})`,
        );
      }
    }
  }

  if (protectGlass && skippedPrims > 0) {
    logger.info?.(
      `permissiveSimplify: protected glass/emissive ${skippedPrims} prims / ${skippedTris.toLocaleString()} tris`,
    );
  }

  return { primCount, srcTris, dstTris, skippedPrims, skippedTris };
}

function countTris(prim) {
  const indices = prim.getIndices();
  if (indices) return Math.floor(indices.getCount() / 3);
  const pos = prim.getAttribute('POSITION');
  return pos ? Math.floor(pos.getCount() / 3) : 0;
}

/**
 * @param {import('@gltf-transform/core').Document} document
 * @param {import('@gltf-transform/core').Primitive} prim
 */
function simplifyPrimitive(document, prim, ratio, error, pruneError, protectUv = true) {
  const position = prim.getAttribute('POSITION');
  const srcIndices = prim.getIndices();
  if (!position || !srcIndices) return;

  let posArray = position.getArray();
  let idxArray = srcIndices.getArray();
  if (!posArray || !idxArray) return;

  if (!(posArray instanceof Float32Array)) {
    posArray = new Float32Array(posArray);
  }
  if (!(idxArray instanceof Uint32Array)) {
    idxArray = new Uint32Array(idxArray);
  }

  const vertCount = posArray.length / 3;
  const uvsAttr = prim.getAttribute('TEXCOORD_0');
  const nrmAttr = prim.getAttribute('NORMAL');
  let uvArray = null;
  let nrmArray = null;
  if (uvsAttr) {
    const a = uvsAttr.getArray();
    if (a) uvArray = a instanceof Float32Array ? a : new Float32Array(a);
  }
  if (nrmAttr) {
    const a = nrmAttr.getArray();
    if (a) nrmArray = a instanceof Float32Array ? a : new Float32Array(a);
  }

  // Position remap (identical positions) → Protect UV discontinuities
  const posRemap = generatePositionRemap(posArray, vertCount);
  const locks = new Uint8Array(vertCount);
  // protectUv=false (coarse LODs): UV seams may collapse — mild texture
  // smearing at distance beats hitting the ~35% seam-lock topology floor.
  if (uvArray && protectUv) {
    for (let i = 0; i < vertCount; i++) {
      const r = posRemap[i];
      if (r === i) continue;
      const du = uvArray[i * 2] - uvArray[r * 2];
      const dv = uvArray[i * 2 + 1] - uvArray[r * 2 + 1];
      if (du * du + dv * dv > 1e-12) {
        locks[i] |= VERTEX_PROTECT;
        locks[r] |= VERTEX_PROTECT;
      }
    }
  }

  // Attribute buffer for simplifyWithAttributes: UV (+ optional normals)
  let attrStride = 0;
  const weights = [];
  if (uvArray) {
    attrStride += 2;
    weights.push(1.0, 1.0);
  }
  if (nrmArray) {
    attrStride += 3;
    weights.push(0.5, 0.5, 0.5);
  }

  const attributes =
    attrStride > 0 ? new Float32Array(vertCount * attrStride) : new Float32Array(0);
  if (attrStride > 0) {
    for (let i = 0; i < vertCount; i++) {
      let o = i * attrStride;
      if (uvArray) {
        attributes[o++] = uvArray[i * 2];
        attributes[o++] = uvArray[i * 2 + 1];
      }
      if (nrmArray) {
        attributes[o++] = nrmArray[i * 3];
        attributes[o++] = nrmArray[i * 3 + 1];
        attributes[o++] = nrmArray[i * 3 + 2];
      }
    }
  }

  // Prune is intentionally NOT passed to simplify: inside simplify it shares
  // target_error as its threshold, so coarse LODs (error 0.04+) delete whole
  // building components. Prune separately with a small fixed threshold instead.
  const flags = /** @type {any} */ (['Permissive']);

  let workIdx = idxArray;
  if (
    pruneError > 0 &&
    typeof MeshoptSimplifier.simplifyPrune === 'function'
  ) {
    const pruned = MeshoptSimplifier.simplifyPrune(
      idxArray,
      posArray,
      3,
      Math.min(pruneError, error),
    );
    if (pruned && pruned.length >= 3) workIdx = pruned;
  }

  // Ratio applies to the original count; clamp so target never exceeds the
  // (possibly pruned) working index buffer.
  const target = Math.min(
    Math.max(3, Math.floor((ratio * idxArray.length) / 3) * 3),
    workIdx.length,
  );

  let dstIndices = null;

  if (attrStride > 0 && typeof MeshoptSimplifier.simplifyWithAttributes === 'function') {
    const [simplified] = MeshoptSimplifier.simplifyWithAttributes(
      workIdx,
      posArray,
      3,
      attributes,
      attrStride,
      weights,
      locks,
      target,
      error,
      flags,
    );
    dstIndices = simplified;
  } else {
    const [simplified] = MeshoptSimplifier.simplify(
      workIdx,
      posArray,
      3,
      target,
      error,
      flags,
    );
    dstIndices = simplified;
  }

  if (!dstIndices || dstIndices.length < 3) {
    dstIndices = idxArray;
  }

  // Compact used vertices
  const used = new Int32Array(vertCount).fill(-1);
  let newCount = 0;
  for (let i = 0; i < dstIndices.length; i++) {
    const vi = dstIndices[i];
    if (used[vi] < 0) used[vi] = newCount++;
  }
  const compactIdx = new Uint32Array(dstIndices.length);
  for (let i = 0; i < dstIndices.length; i++) {
    compactIdx[i] = used[dstIndices[i]];
  }

  const buf = position.getBuffer() || document.getRoot().listBuffers()[0];

  const newPos = new Float32Array(newCount * 3);
  for (let old = 0; old < vertCount; old++) {
    const ni = used[old];
    if (ni < 0) continue;
    newPos[ni * 3] = posArray[old * 3];
    newPos[ni * 3 + 1] = posArray[old * 3 + 1];
    newPos[ni * 3 + 2] = posArray[old * 3 + 2];
  }
  prim.setAttribute(
    'POSITION',
    document.createAccessor().setType('VEC3').setArray(newPos).setBuffer(buf),
  );

  if (uvArray && uvsAttr) {
    const newUv = new Float32Array(newCount * 2);
    for (let old = 0; old < vertCount; old++) {
      const ni = used[old];
      if (ni < 0) continue;
      newUv[ni * 2] = uvArray[old * 2];
      newUv[ni * 2 + 1] = uvArray[old * 2 + 1];
    }
    prim.setAttribute(
      'TEXCOORD_0',
      document
        .createAccessor()
        .setType('VEC2')
        .setArray(newUv)
        .setBuffer(uvsAttr.getBuffer() || buf),
    );
  }

  if (nrmArray && nrmAttr) {
    const newN = new Float32Array(newCount * 3);
    for (let old = 0; old < vertCount; old++) {
      const ni = used[old];
      if (ni < 0) continue;
      newN[ni * 3] = nrmArray[old * 3];
      newN[ni * 3 + 1] = nrmArray[old * 3 + 1];
      newN[ni * 3 + 2] = nrmArray[old * 3 + 2];
    }
    prim.setAttribute(
      'NORMAL',
      document
        .createAccessor()
        .setType('VEC3')
        .setArray(newN)
        .setBuffer(nrmAttr.getBuffer() || buf),
    );
  }

  // Drop other attributes that no longer match vertex count
  for (const sem of prim.listSemantics()) {
    if (sem === 'POSITION' || sem === 'TEXCOORD_0' || sem === 'NORMAL') continue;
    prim.setAttribute(sem, null);
  }

  prim.setIndices(
    document
      .createAccessor()
      .setType('SCALAR')
      .setArray(newCount <= 65534 ? new Uint16Array(compactIdx) : compactIdx)
      .setBuffer(srcIndices.getBuffer() || buf),
  );
}

/** Position-only remap: vertices with identical quantized positions map to the first index. */
function generatePositionRemap(pos, vertCount) {
  const map = new Map();
  const remap = new Uint32Array(vertCount);
  for (let i = 0; i < vertCount; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = i;
      map.set(key, id);
    }
    remap[i] = id;
  }
  return remap;
}
