/**
 * Read GLB metadata without decoding geometry buffers.
 * Parses only the JSON chunk (12-byte header + chunk length + JSON).
 */
import { openSync, readSync, closeSync, statSync } from 'node:fs';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'

/**
 * @param {string} glbPath
 * @returns {{ dims_m: {x:number,y:number,z:number}|null, bbox:{min:number[],max:number[]}|null, triangleEstimate:number|null, error:string|null }}
 */
export function readGlbMeta(glbPath) {
  const parsed = readGlbJson(glbPath);
  if (parsed.error) return emptyMeta(parsed.error);
  return metaFromGltf(parsed.json);
}

/**
 * Parse only a GLB's JSON chunk.
 * @param {string} glbPath
 * @returns {{ json: object|null, error: string|null }}
 */
export function readGlbJson(glbPath) {
  let fd;
  try {
    const size = statSync(glbPath).size;
    if (size < 20) {
      return { json: null, error: 'file too small' };
    }
    fd = openSync(glbPath, 'r');
    const header = Buffer.alloc(12);
    readSync(fd, header, 0, 12, 0);
    const magic = header.readUInt32LE(0);
    if (magic !== GLB_MAGIC) {
      return { json: null, error: 'not a GLB' };
    }
    const chunkLen = Buffer.alloc(8);
    readSync(fd, chunkLen, 0, 8, 12);
    const jsonLen = chunkLen.readUInt32LE(0);
    const chunkType = chunkLen.readUInt32LE(4);
    if (chunkType !== CHUNK_JSON) {
      return { json: null, error: 'first chunk is not JSON' };
    }
    if (jsonLen <= 0 || jsonLen > size - 20) {
      return { json: null, error: 'invalid JSON chunk length' };
    }
    const jsonBuf = Buffer.alloc(jsonLen);
    readSync(fd, jsonBuf, 0, jsonLen, 20);
    const text = jsonBuf.toString('utf8').replace(/\0+$/, '');
    return { json: JSON.parse(text), error: null };
  } catch (err) {
    return { json: null, error: err.message || String(err) };
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * @param {object} gltf
 */
export function metaFromGltf(gltf) {
  const accessors = gltf.accessors || [];
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  let found = false;
  let triEstimate = 0;

  for (const mesh of gltf.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const posIdx = prim.attributes?.POSITION;
      if (posIdx != null && accessors[posIdx]) {
        const acc = accessors[posIdx];
        if (Array.isArray(acc.min) && Array.isArray(acc.max) && acc.min.length >= 3) {
          found = true;
          for (let i = 0; i < 3; i++) {
            lo[i] = Math.min(lo[i], acc.min[i]);
            hi[i] = Math.max(hi[i], acc.max[i]);
          }
        }
      }
      const mode = prim.mode ?? 4; // TRIANGLES
      if (mode === 4) {
        if (prim.indices != null && accessors[prim.indices]) {
          triEstimate += Math.floor(accessors[prim.indices].count / 3);
        } else if (posIdx != null && accessors[posIdx]) {
          triEstimate += Math.floor(accessors[posIdx].count / 3);
        }
      }
    }
  }

  if (!found) {
    return {
      dims_m: null,
      bbox: null,
      triangleEstimate: triEstimate || null,
      error: 'no POSITION min/max in accessors',
    };
  }

  const dims = {
    x: round3(hi[0] - lo[0]),
    y: round3(hi[1] - lo[1]),
    z: round3(hi[2] - lo[2]),
  };

  return {
    dims_m: dims,
    bbox: {
      min: lo.map(round3),
      max: hi.map(round3),
    },
    triangleEstimate: triEstimate || null,
    error: null,
  };
}

function emptyMeta(error) {
  return { dims_m: null, bbox: null, triangleEstimate: null, error };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * World-space bounds — accessor bboxes pushed through the node hierarchy.
 *
 * `metaFromGltf` reads accessor min/max directly, which is the mesh's *local*
 * box. That is fine when the scene graph is identity, and wrong the moment an
 * asset carries a rotation on its root node: several cars in `Cars/` store their
 * vertices lying on the X axis and stand them up with a node rotation, so the
 * local box reports a 4.9 m-wide, 2.1 m-long car (and one that is 6.26 m tall).
 * Anything comparing an asset against a Blender-baked derivative — which has the
 * transform applied — must use these bounds, or every such asset reads as a
 * catastrophic silhouette failure.
 *
 * Ignores EXT_mesh_gpu_instancing: instance transforms would widen the box, and
 * no vehicle uses it.
 *
 * @param {object} gltf parsed glTF JSON
 * @returns {{ dims_m: {x:number,y:number,z:number}|null, bbox: {min:number[],max:number[]}|null, triangleEstimate: number|null, error: string|null }}
 */
export function worldMetaFromGltf(gltf) {
  const local = metaFromGltf(gltf);
  const accessors = gltf.accessors || [];
  const nodes = gltf.nodes || [];
  if (!nodes.length) return local;

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let found = false;

  const roots =
    gltf.scenes?.[gltf.scene ?? 0]?.nodes ??
    gltf.scenes?.[0]?.nodes ??
    nodes.map((_, i) => i);

  /** @param {number} index @param {number[]} parent 4x4 column-major */
  const walk = (index, parent, depth) => {
    const node = nodes[index];
    // Guard against a malformed cyclic graph rather than blowing the stack.
    if (!node || depth > 64) return;
    const world = multiply4(parent, nodeMatrix(node));

    if (node.mesh != null) {
      for (const prim of gltf.meshes?.[node.mesh]?.primitives || []) {
        const acc = accessors[prim.attributes?.POSITION];
        if (!acc || !Array.isArray(acc.min) || !Array.isArray(acc.max)) continue;
        // All eight corners: a rotation maps the box onto a new axis-aligned one.
        for (let c = 0; c < 8; c++) {
          const p = [
            c & 1 ? acc.max[0] : acc.min[0],
            c & 2 ? acc.max[1] : acc.min[1],
            c & 4 ? acc.max[2] : acc.min[2],
          ];
          const w = transformPoint(world, p);
          found = true;
          for (let i = 0; i < 3; i++) {
            lo[i] = Math.min(lo[i], w[i]);
            hi[i] = Math.max(hi[i], w[i]);
          }
        }
      }
    }
    for (const child of node.children || []) walk(child, world, depth + 1);
  };

  for (const root of roots) walk(root, IDENTITY4, 0);

  if (!found) return local;

  return {
    dims_m: {
      x: round3(hi[0] - lo[0]),
      y: round3(hi[1] - lo[1]),
      z: round3(hi[2] - lo[2]),
    },
    bbox: { min: lo.map(round3), max: hi.map(round3) },
    triangleEstimate: local.triangleEstimate,
    error: null,
  };
}

/** World-space twin of {@link readGlbMeta}. */
export function readGlbWorldMeta(glbPath) {
  const parsed = readGlbJson(glbPath);
  if (parsed.error) return emptyMeta(parsed.error);
  return worldMetaFromGltf(parsed.json);
}

const IDENTITY4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** glTF node → 4x4 column-major matrix (explicit `matrix` wins over TRS). */
function nodeMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];

  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** a x b, both column-major. */
function multiply4(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
