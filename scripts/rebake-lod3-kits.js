#!/usr/bin/env node
/**
 * Rebake LOD3 height-slice silhouettes from default.glb (parallel Blender jobs).
 * Walks Kitbash Assets kits; prefers cooked output/<Kit>/<Asset>/default.glb,
 * falls back to the source .glb when default is missing.
 *
 *   npm run rebake:lod3 -- --force
 *   npm run rebake:lod3 -- --force --jobs 2 Manhattan
 *   LOD3_JOBS=2 LOD3_RES=2048 LOD3_SLICES=8 npm run rebake:lod3 -- --force
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { cpus, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { bakeLod3Silhouette } from '../src/lod3-silhouette.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'output');
const KITS_ROOT = join(ROOT, 'Kitbash Assets');
const DEFAULT_KITS = ['Manhattan', 'Every City', 'Brooklyn'];
const MIN_DEFAULT_BYTES = 64 * 1024;
const RESOLUTION = Number(process.env.LOD3_RES || 2048);
const SLICES = Number(process.env.LOD3_SLICES || 8);

const argv = process.argv.slice(2);
const force = argv.includes('--force');

/** @type {string[]} */
const kitFilter = [];
let jobsCli = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--force') continue;
  if (a === '--jobs' || a === '-j') {
    jobsCli = Number(argv[++i]);
    continue;
  }
  if (a.startsWith('--jobs=')) {
    jobsCli = Number(a.slice('--jobs='.length));
    continue;
  }
  kitFilter.push(a);
}

const cpuCount = typeof cpus === 'function' ? cpus().length || 4 : 4;
const JOBS = Math.max(
  1,
  Math.min(
    8,
    Number.isFinite(jobsCli) && jobsCli > 0
      ? jobsCli
      : Number(process.env.LOD3_JOBS || 2) || 2,
  ),
);
const kits = kitFilter.length ? kitFilter : DEFAULT_KITS;

/**
 * @typedef {{ kit: string, asset: string, outDir: string, sourceGlb: string, sourceLabel: string }} Job
 */

/** @returns {Job[]} */
function listJobs() {
  /** @type {Job[]} */
  const jobs = [];

  for (const kit of kits) {
    const kitDir = join(KITS_ROOT, kit);
    if (!existsSync(kitDir) || !statSync(kitDir).isDirectory()) {
      console.warn(`WARN: kit folder missing: Kitbash Assets\\${kit}`);
      continue;
    }

    const glbs = readdirSync(kitDir)
      .filter((f) => f.toLowerCase().endsWith('.glb'))
      .sort((a, b) => a.localeCompare(b));

    for (const file of glbs) {
      const asset = basename(file, '.glb');
      const outDir = join(OUTPUT, kit, asset);
      const cookedDefault = join(outDir, 'default.glb');
      const sourceKit = join(kitDir, file);

      let sourceGlb = null;
      let sourceLabel = null;

      if (existsSync(cookedDefault) && statSync(cookedDefault).size >= MIN_DEFAULT_BYTES) {
        sourceGlb = cookedDefault;
        sourceLabel = 'default';
      } else if (existsSync(sourceKit) && statSync(sourceKit).size >= MIN_DEFAULT_BYTES) {
        sourceGlb = sourceKit;
        sourceLabel = 'kitbash';
      }

      if (!sourceGlb) {
        console.warn(
          `WARN: skip ${kit}\\${asset} — no usable default/kitbash .glb (≥${MIN_DEFAULT_BYTES} B)`,
        );
        continue;
      }

      jobs.push({ kit, asset, outDir, sourceGlb, sourceLabel });
    }
  }

  return jobs;
}

function patchAssetJson(outDir, meta) {
  const path = join(outDir, 'asset.json');
  let asset = {};
  if (existsSync(path)) {
    try {
      asset = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      asset = {};
    }
  }
  asset.lod3 = {
    ok: true,
    file: 'lod3.glb',
    atlas: 'lod3_atlas/',
    triangles: meta.triangles,
    slices: meta.slices,
    resolution: meta.resolution,
    backend: meta.backend || 'height-slice+blender',
    source: meta.source || 'default',
    alphaMode: 'MASK',
  };
  writeFileSync(path, JSON.stringify(asset, null, 2));
}

/**
 * Run async tasks with a fixed concurrency pool.
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} worker
 */
async function mapPool(items, concurrency, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

const allJobs = listJobs();
console.log(
  `KitBash LOD3 rebake — ${allJobs.length} asset(s), ${RESOLUTION}px, slices≤${SLICES}, jobs=${JOBS} (cpu=${cpuCount})`,
);
console.log(`  kits: ${kits.join(', ')}`);
console.log(`  prefer: output\\<Kit>\\<Asset>\\default.glb  (fallback: Kitbash .glb)`);
if (!allJobs.length) {
  console.log('Nothing to do.');
  process.exit(0);
}

let ok = 0;
let skip = 0;
let fail = 0;

await mapPool(allJobs, JOBS, async (job) => {
  const rel = `${job.kit}\\${job.asset}`;
  mkdirSync(job.outDir, { recursive: true });

  if (!force && existsSync(join(job.outDir, 'lod3.glb'))) {
    console.log(`SKIP ${rel} — lod3.glb exists (use --force)`);
    skip++;
    return;
  }

  const mb = (statSync(job.sourceGlb).size / (1024 * 1024)).toFixed(1);
  console.log(`→ ${rel} from ${job.sourceLabel} (${mb} MB) [parallel]`);

  const workDir = join(
    tmpdir(),
    `hp-lod3-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  mkdirSync(workDir, { recursive: true });
  try {
    const result = await bakeLod3Silhouette({
      inputGlb: job.sourceGlb,
      outDir: job.outDir,
      workDir,
      resolution: RESOLUTION,
      slices: SLICES,
      method: process.env.LOD3_METHOD || 'visual-hull',
    });
    patchAssetJson(job.outDir, {
      triangles: result.triangles,
      slices: result.slices,
      resolution: result.resolution,
      backend: result.backend,
      source: job.sourceLabel,
    });
    console.log(`OK ${rel} — ${result.triangles} tris`);
    ok++;
  } catch (err) {
    console.error(`FAIL ${rel}: ${err.message}`);
    fail++;
    const path = join(job.outDir, 'asset.json');
    if (existsSync(path)) {
      try {
        const asset = JSON.parse(readFileSync(path, 'utf8'));
        asset.lod3 = { ok: false, reason: err.message };
        writeFileSync(path, JSON.stringify(asset, null, 2));
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

console.log(`\nDone. OK=${ok} skip=${skip} fail=${fail} (jobs=${JOBS})`);
process.exit(fail ? 1 : 0);
