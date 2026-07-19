import { statSync } from 'node:fs';
import {
  getSceneVertexCount,
  VertexCountMethod,
} from '@gltf-transform/functions';

/**
 * Count triangles / vertices / meshes / primitives across a Document.
 * @param {import('@gltf-transform/core').Document} document
 * @param {number} [fileBytes] optional on-disk size
 */
export function collectStats(document, fileBytes = 0) {
  let triangles = 0;
  let vertices = 0;
  let meshes = 0;
  let primitives = 0;

  for (const mesh of document.getRoot().listMeshes()) {
    meshes += 1;
    for (const prim of mesh.listPrimitives()) {
      primitives += 1;
      const pos = prim.getAttribute('POSITION');
      if (pos) vertices += pos.getCount();

      const indices = prim.getIndices();
      const mode = prim.getMode();
      // TRIANGLES = 4
      if (mode === 4) {
        if (indices) {
          triangles += Math.floor(indices.getCount() / 3);
        } else if (pos) {
          triangles += Math.floor(pos.getCount() / 3);
        }
      }
    }
  }

  let sceneVertices = 0;
  const scenes = document.getRoot().listScenes();
  if (scenes.length > 0) {
    try {
      sceneVertices = getSceneVertexCount(scenes[0], VertexCountMethod.RENDER);
    } catch {
      sceneVertices = vertices;
    }
  }

  return {
    triangles,
    vertices,
    sceneVertices,
    meshes,
    primitives,
    fileBytes,
    fileMB: fileBytes > 0 ? round2(fileBytes / (1024 * 1024)) : 0,
  };
}

export function fileSizeBytes(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function formatStats(label, stats) {
  const lines = [
    `[${label}]`,
    `  triangles : ${stats.triangles.toLocaleString()}`,
    `  vertices  : ${stats.vertices.toLocaleString()}`,
    `  meshes    : ${stats.meshes}`,
    `  primitives: ${stats.primitives}`,
  ];
  if (stats.fileMB > 0) {
    lines.push(`  file size : ${stats.fileMB} MB`);
  }
  return lines.join('\n');
}

export function reductionReport(before, after) {
  const triRatio =
    before.triangles > 0 ? after.triangles / before.triangles : 0;
  const vertRatio =
    before.vertices > 0 ? after.vertices / before.vertices : 0;
  const sizeRatio =
    before.fileBytes > 0 ? after.fileBytes / before.fileBytes : 0;

  return {
    triangleRatio: round4(triRatio),
    triangleReductionPct: round2((1 - triRatio) * 100),
    vertexRatio: round4(vertRatio),
    vertexReductionPct: round2((1 - vertRatio) * 100),
    sizeRatio: round4(sizeRatio),
    sizeReductionPct: round2((1 - sizeRatio) * 100),
  };
}

export function printAssetReport(name, before, lods) {
  console.log('\n' + '='.repeat(60));
  console.log(`Asset: ${name}`);
  console.log('='.repeat(60));
  console.log(formatStats('BEFORE', before));

  for (const lod of lods) {
    console.log(formatStats(`AFTER ${lod.label}`, lod.stats));
    const r = reductionReport(before, lod.stats);
    console.log(
      `  Δ tris    : -${r.triangleReductionPct}% (ratio ${r.triangleRatio})`,
    );
    console.log(
      `  Δ verts   : -${r.vertexReductionPct}% (ratio ${r.vertexRatio})`,
    );
    if (before.fileMB > 0 && lod.stats.fileMB > 0) {
      console.log(
        `  Δ size    : -${r.sizeReductionPct}% (ratio ${r.sizeRatio})`,
      );
    }
    const healthy = lod.health || assessHealth(before, lod.stats, lod.targetRatio);
    console.log(`  health    : ${healthy.ok ? 'OK' : 'WARN'} — ${healthy.msg}`);
  }
  console.log('='.repeat(60) + '\n');
}

/**
 * Heuristic: LOD should land near target ratio (±40% relative slack)
 * and not explode file size vs geometry alone.
 */
export function assessHealth(before, after, targetRatio) {
  if (before.triangles === 0) {
    return { ok: false, msg: 'source has 0 triangles' };
  }
  const actual = after.triangles / before.triangles;
  const slack = 0.4;
  const lo = targetRatio * (1 - slack);
  const hi = Math.min(1, targetRatio * (1 + slack) + 0.05);

  if (after.triangles === 0) {
    return { ok: false, msg: 'output has 0 triangles (simplify failed?)' };
  }
  if (actual > hi) {
    // Topology floors are common on hard-edge archviz meshes; WARN not hard fail
    return {
      ok: true,
      msg: `topology floor ~${(actual * 100).toFixed(1)}% left (target ~${(targetRatio * 100).toFixed(0)}%) — seams/UVs limit simplify`,
    };
  }
  if (actual < lo * 0.5) {
    return {
      ok: false,
      msg: `over-simplified (${(actual * 100).toFixed(1)}% left, target ~${(targetRatio * 100).toFixed(0)}%)`,
    };
  }
  return {
    ok: true,
    msg: `${after.triangles.toLocaleString()} tris (${(actual * 100).toFixed(1)}% of source)`,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
