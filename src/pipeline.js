import { mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  reorder,
  dedup,
  prune,
  flatten,
  join,
  textureCompress,
} from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import {
  normalizeToGlb,
  runBlenderBakeNormals,
  assetStem,
  makeWorkDir,
} from './convert.js';
import { runAtlasBake } from './atlas.js';
import { validateAtlasBake } from './atlas-qc.js';
import { mergeMaterials } from './material-merge.js';
import { compressTexturesKtx2 } from './ktx2.js';
import { permissiveSimplify } from './permissive-simplify.js';
import { generateImpostor } from './impostor.js';
import {
  collectStats,
  fileSizeBytes,
  printAssetReport,
  reductionReport,
  assessHealth,
} from './stats.js';

/**
 * @typedef {object} PipelineOptions
 * @property {string} input
 * @property {string} output
 * @property {number[]} ratios
 * @property {number} error
 * @property {number[]|null} [errors]
 * @property {boolean} bake
 * @property {number} bakeRes
 * @property {number|null} maxTexture
 * @property {boolean} pack
 * @property {string|null} blender
 * @property {string|null} gltfpack
 * @property {string|null} [toktx]
 * @property {boolean} keepWork
 * @property {boolean} impostor
 * @property {string} [impostorMode]
 * @property {number} impostorRes
 * @property {number} [impostorFrames]
 * @property {boolean} impostorTop
 * @property {boolean} atlas
 * @property {boolean} hero
 * @property {boolean} ktx2
 */

export async function processAsset(assetPath, options) {
  const stem = assetStem(assetPath, options.input);
  const outDir = pathJoin(options.output, stem);
  mkdirSync(outDir, { recursive: true });

  const workDir = makeWorkDir(outDir);
  console.log(`\n→ Processing: ${assetPath}`);
  console.log(`  work dir : ${workDir}`);
  console.log(`  output   : ${outDir}`);

  try {
    const { glbPath: rawGlb, sourceFormat, converted } = await normalizeToGlb(
      assetPath,
      workDir,
      { blender: options.blender, gltfpack: options.gltfpack },
    );
    console.log(
      `  source   : ${sourceFormat}${converted ? ' (converted→glb)' : ''}`,
    );

    let glbPath = rawGlb;
    const io = createIO();
    await MeshoptSimplifier.ready;
    await MeshoptEncoder.ready;

    const rawDoc = await io.read(glbPath);
    const beforeRaw = collectStats(rawDoc, fileSizeBytes(glbPath));

    // 1) Optional experimental atlas bake (QC-gated)
    let atlasUsed = false;
    if (options.atlas) {
      const atlasRes = options.hero ? 2048 : 1024;
      const atlasGlb = pathJoin(workDir, 'atlas.glb');
      const mapsDir = pathJoin(outDir, 'atlas_maps');
      try {
        runAtlasBake({
          inputGlb: glbPath,
          outputGlb: atlasGlb,
          mapsDir,
          resolution: atlasRes,
          blender: options.blender,
        });
        const qc = await validateAtlasBake(atlasGlb, mapsDir);
        if (qc.ok) {
          glbPath = atlasGlb;
          atlasUsed = true;
          console.log(
            `  atlas   : QC OK (luma ${qc.meanLuminance?.toFixed(3)}, uvArea ${qc.uvFaceAreaSum?.toFixed(3)})`,
          );
        } else {
          console.warn(`  atlas   : QC REJECTED — ${qc.reason}`);
          console.warn('  atlas   : continuing without atlas');
        }
      } catch (err) {
        console.warn(`  atlas   : FAILED — ${err.message}`);
        console.warn('  atlas   : continuing without atlas');
      }
    }

    let sourceDoc = await io.read(glbPath);

    // 2) Material merge (no rebake) — always
    const mergeStats = await mergeMaterials(sourceDoc);
    console.log(
      `  materials: merge ${mergeStats.materialsBefore} → ${mergeStats.materialsAfter} mat | ${mergeStats.texturesBefore} → ${mergeStats.texturesAfter} tex (slots remapped ${mergeStats.merged})`,
    );
    const mergedGlb = pathJoin(workDir, 'merged.glb');
    await io.write(mergedGlb, sourceDoc);
    glbPath = mergedGlb;
    sourceDoc = await io.read(glbPath);

    // Optional texture cap
    if (options.maxTexture) {
      console.log(`  textures : resize max ${options.maxTexture}px`);
      await sourceDoc.transform(
        textureCompress({
          encoder: sharp,
          resize: [options.maxTexture, options.maxTexture],
        }),
      );
      await io.write(glbPath, sourceDoc);
      sourceDoc = await io.read(glbPath);
    }

    // Impostor MUST bake from PNG/JPEG textures — Puppeteer/Three has no KTX2 transcoder.
    // Keep a pre-KTX2 snapshot for the octahedral baker.
    const impostorSourceGlb = glbPath;

    // 3) KTX2 once on shared textures (before LOD fork)
    if (options.ktx2 !== false) {
      try {
        const k = await compressTexturesKtx2(sourceDoc, { toktx: options.toktx });
        console.log(`  ktx2    : ${k.converted}/${k.total} textures (shared across LODs)`);
        const ktxGlb = pathJoin(workDir, 'source_ktx2.glb');
        await io.write(ktxGlb, sourceDoc);
        glbPath = ktxGlb;
        sourceDoc = await io.read(glbPath);
      } catch (err) {
        console.warn(`  ktx2    : skipped — ${err.message}`);
      }
    }

    // Geometry baseline after instance expand (same join as LOD path)
    const baselineDoc = await io.read(glbPath);
    await baselineDoc.transform(dedup(), flatten(), join());
    const beforeGeom = collectStats(baselineDoc, fileSizeBytes(glbPath));
    console.log(
      `  geometry: ${beforeGeom.triangles.toLocaleString()} tris after join (${beforeRaw.triangles.toLocaleString()} instanced)`,
    );

    // 4) LOD chain from KTX2 source (geometry only per LOD)
    const lodResults = [];
    const ratios = options.ratios?.length ? options.ratios : [0.5, 0.3, 0.1];

    for (let i = 0; i < ratios.length; i++) {
      const ratio = ratios[i];
      const label = `LOD${i}`;
      const lodPath = pathJoin(outDir, `lod${i}.glb`);
      const lodError =
        Array.isArray(options.errors) && options.errors[i] != null
          ? options.errors[i]
          : options.error * Math.pow(4, i);
      const useSloppy = i >= 2 && ratio <= 0.12;

      console.log(
        `  ${label}: permissive simplify ratio=${ratio} error=${lodError}${
          useSloppy ? ' (sloppy fallback ok)' : ''
        }`,
      );

      // Fresh copy of shared-texture source each LOD
      const doc = await io.read(glbPath);
      // Join meshes for fewer draw calls; do NOT weld before simplify
      // (weld would destroy UV discontinuities needed for Protect).
      await doc.transform(dedup(), flatten(), join());

      const simp = await permissiveSimplify(doc, {
        ratio,
        error: lodError,
        useSloppy,
      });
      console.log(
        `  ${label}: tris ${simp.srcTris.toLocaleString()} → ${simp.dstTris.toLocaleString()}`,
      );

      await MeshoptEncoder.ready;
      await doc.transform(
        reorder({ encoder: MeshoptEncoder, target: 'performance' }),
        prune(),
      );

      // LOD1+ are geometry-only: textures live in lod0 and engines map materials
      // by name/index (order is identical across LODs). Keeps lod1/2 at a few MB
      // instead of duplicating the full texture set per LOD.
      if (i >= 1) {
        const strippedCount = stripTextures(doc);
        console.log(
          `  ${label}: stripped ${strippedCount} textures (geometry-only, material name stubs kept)`,
        );
      }

      await io.write(lodPath, doc);

      if (options.bake && i === 0) {
        console.log(`  ${label}: baking normals (${options.bakeRes}px)...`);
        const normalsPng = pathJoin(outDir, 'normals.png');
        const bakedGlb = pathJoin(outDir, 'lod0_baked.glb');
        try {
          runBlenderBakeNormals({
            blender: options.blender,
            highGlb: rawGlb,
            lowGlb: lodPath,
            outputGlb: bakedGlb,
            normalsPng,
            resolution: options.bakeRes,
          });
          copyFileSync(bakedGlb, lodPath);
          rmSync(bakedGlb, { force: true });
          console.log(`  ${label}: bake OK`);
        } catch (err) {
          console.warn(`  ${label}: bake skipped — ${err.message}`);
        }
      }

      const stats = collectStats(await io.read(lodPath), fileSizeBytes(lodPath));
      const health = assessHealth(beforeGeom, stats, ratio);
      lodResults.push({
        label,
        level: i,
        targetRatio: ratio,
        path: lodPath,
        stats,
        health,
        baked: false,
        reduction: reductionReport(beforeGeom, stats),
      });
    }

    // 5) Impostor from merged (+ optional atlas) source
    let impostorInfo = null;
    if (options.impostor) {
      const impostorPath = pathJoin(outDir, 'impostor.glb');
      const facesDir = pathJoin(outDir, 'impostor_faces');
      const mode = options.impostorMode || 'octahedral';
      // High-quality defaults: 4096/12 ≈ 341px per view (old 1024/8 = 128px looked PS1)
      let impostorRes =
        options.impostorRes || (mode === 'octahedral' ? 4096 : 512);
      let impostorFrames = options.impostorFrames || 12;
      if (options.hero && mode === 'octahedral') {
        if (options.impostorRes == null) impostorRes = 4096;
        if (options.impostorFrames == null || options.impostorFrames === 12) {
          impostorFrames = 16;
        }
      }
      try {
        const result = await generateImpostor({
          inputGlb: impostorSourceGlb,
          outputGlb: impostorPath,
          facesDir,
          outDir,
          resolution: impostorRes,
          includeTop: !!options.impostorTop,
          blender: options.blender,
          mode,
          frames: impostorFrames,
        });
        const stats = collectStats(
          await io.read(impostorPath),
          fileSizeBytes(impostorPath),
        );
        impostorInfo = {
          path: impostorPath,
          backend: result.backend,
          mode,
          stats,
          atlasPath: result.atlasPath || null,
        };
        lodResults.push({
          label: 'IMPOSTOR',
          level: 'impostor',
          targetRatio: 0,
          path: impostorPath,
          stats,
          health: {
            ok: true,
            msg:
              mode === 'octahedral'
                ? `octahedral — open preview.html`
                : `box impostor`,
          },
          baked: false,
          impostor: true,
          reduction: reductionReport(beforeGeom, stats),
        });
        console.log(`  impostor: OK (${mode}, ${stats.fileMB} MB)`);
      } catch (err) {
        console.warn(`  impostor: skipped — ${err.message}`);
      }
    }

    let packPath = null;
    if (options.pack !== false && lodResults.some((l) => !l.impostor)) {
      packPath = await writePackGlb(io, lodResults, outDir, stem, impostorInfo);
    }

    printAssetReport(stem, beforeGeom, lodResults);

    const report = {
      name: stem,
      source: assetPath,
      sourceFormat,
      generatedAt: new Date().toISOString(),
      options: {
        ratios,
        atlas: !!options.atlas,
        atlasUsed,
        hero: !!options.hero,
        ktx2: options.ktx2 !== false,
        impostor: options.impostor,
        impostorMode: options.impostorMode || 'octahedral',
      },
      beforeRaw,
      before: beforeGeom,
      materialMerge: mergeStats,
      lods: lodResults.map((l) => ({
        label: l.label,
        level: l.level,
        targetRatio: l.targetRatio,
        path: l.path,
        stats: l.stats,
        health: l.health,
        impostor: !!l.impostor,
        reduction: l.reduction,
      })),
      impostor: impostorInfo,
      pack: packPath,
    };

    try {
      report.materialsBefore = rawDoc.getRoot().listMaterials().length;
      report.texturesBefore = rawDoc.getRoot().listTextures().length;
      const lod0Doc = await io.read(lodResults[0].path);
      report.materialsAfter = lod0Doc.getRoot().listMaterials().length;
      report.texturesAfter = lod0Doc.getRoot().listTextures().length;
    } catch {
      report.materialsBefore = mergeStats.materialsBefore;
      report.materialsAfter = mergeStats.materialsAfter;
      report.texturesBefore = mergeStats.texturesBefore;
      report.texturesAfter = mergeStats.texturesAfter;
    }

    const reportPath = pathJoin(outDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`  report   : ${reportPath}`);
    if (report.materialsBefore != null) {
      console.log(
        `  materials: ${report.materialsBefore} → ${report.materialsAfter} | textures: ${report.texturesBefore} → ${report.texturesAfter}`,
      );
    }

    return report;
  } finally {
    if (!options.keepWork && existsSync(workDir)) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

function createIO() {
  return new NodeIO().registerExtensions(ALL_EXTENSIONS);
}

/** Detach and dispose every texture; materials survive as name stubs. */
function stripTextures(doc) {
  const textures = doc.getRoot().listTextures();
  for (const texture of textures) {
    texture.dispose();
  }
  return textures.length;
}

async function writePackGlb(io, lodResults, outDir, stem, impostorInfo = null) {
  const meshLod = lodResults.find((l) => !l.impostor) || lodResults[0];
  if (!meshLod) return null;
  const packDoc = await io.read(meshLod.path);
  const asset = packDoc.getRoot().getAsset();
  asset.extras = {
    ...(asset.extras || {}),
    hpPipeline: {
      name: stem,
      lodFiles: lodResults
        .filter((l) => !l.impostor)
        .map((l) => ({
          level: l.level,
          file: `lod${l.level}.glb`,
          targetRatio: l.targetRatio,
          triangles: l.stats.triangles,
        })),
      impostor: impostorInfo
        ? {
            file: 'impostor.glb',
            mode: impostorInfo.mode,
            preview: 'preview.html',
          }
        : null,
    },
  };
  const packPath = pathJoin(outDir, 'pack.glb');
  await io.write(packPath, packDoc);
  console.log(`  pack     : ${packPath}`);
  return packPath;
}

export async function processBatch(assets, options) {
  mkdirSync(options.output, { recursive: true });
  const reports = [];
  const failures = [];

  for (const asset of assets) {
    try {
      reports.push(await processAsset(asset, options));
    } catch (err) {
      console.error(`\n✗ FAILED: ${asset}`);
      console.error(`  ${err.message}`);
      failures.push({ asset, error: err.message });
    }
  }

  const summaryPath = pathJoin(options.output, 'batch_summary.json');
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        total: assets.length,
        ok: reports.length,
        failed: failures.length,
        failures,
        assets: reports.map((r) => ({
          name: r.name,
          beforeTris: r.before?.triangles,
          lod0Tris: r.lods?.[0]?.stats?.triangles,
          lod0MB: r.lods?.[0]?.stats?.fileMB,
          materialsBefore: r.materialsBefore,
          materialsAfter: r.materialsAfter,
          atlasUsed: r.options?.atlasUsed,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nBatch summary: ${summaryPath}`);
  console.log(`  OK: ${reports.length}  Failed: ${failures.length}`);
  return { reports, failures };
}
