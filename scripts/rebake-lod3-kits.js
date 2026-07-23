#!/usr/bin/env node
/**
 * Rebake LOD3 slicecards (silhouette slice stack; boxcards fallback) from default.glb (parallel jobs).
 * Walks Kitbash Assets kits; prefers cooked output/<Kit>/<Asset>/default.glb,
 * falls back to the source .glb when default is missing.
 *
 *   npm run rebake:lod3 -- --force
 *   npm run rebake:lod3 -- --force --jobs 2 Manhattan
 *   LOD3_JOBS=2 LOD3_RES=2048 npm run rebake:lod3 -- --force
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

      // Shared-texture cooks write external URIs in default.glb — Puppeteer cannot
      // resolve ../_shared/ from a temp work dir. Prefer KitBash source (embedded).
      const assetJsonPath = join(outDir, 'asset.json');
      let sharedTextures = false;
      if (existsSync(assetJsonPath)) {
        try {
          const aj = JSON.parse(readFileSync(assetJsonPath, 'utf8'));
          sharedTextures = aj.sharedTextures === true;
        } catch {
          sharedTextures = false;
        }
      }

      if (
        !sharedTextures &&
        existsSync(cookedDefault) &&
        statSync(cookedDefault).size >= MIN_DEFAULT_BYTES
      ) {
        sourceGlb = cookedDefault;
        sourceLabel = 'default';
      } else if (existsSync(sourceKit) && statSync(sourceKit).size >= MIN_DEFAULT_BYTES) {
        sourceGlb = sourceKit;
        sourceLabel = sharedTextures ? 'kitbash (sharedTextures)' : 'kitbash';
      } else if (
        existsSync(cookedDefault) &&
        statSync(cookedDefault).size >= MIN_DEFAULT_BYTES
      ) {
        sourceGlb = cookedDefault;
        sourceLabel = 'default';
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
    resolution: meta.resolution,
    backend: meta.backend || 'boxcards',
    source: meta.source || 'default',
    alphaMode: 'MASK',
  };
  if (!Array.isArray(asset.lods)) asset.lods = [];
  let entry = asset.lods.find((l) => l.level === 3);
  if (!entry) {
    entry = { level: 3, file: 'lod3.glb' };
    asset.lods.push(entry);
  }
  entry.triangles = meta.triangles;
  entry.atlas = true;
  entry.maps = 'lod3_atlas/';
  entry.note =
    meta.backend === 'slicecards'
      ? 'silhouette slice stack + box-projected MASK atlas; self-contained'
      : '6-plane boxcards + MASK atlas; self-contained';
  entry.targetRatio = null;
  writeFileSync(path, JSON.stringify(asset, null, 2));
}

/**
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
  `KitBash LOD3 boxcards rebake — ${allJobs.length} asset(s), ${RESOLUTION}px, jobs=${JOBS} (cpu=${cpuCount})`,
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
    });
    patchAssetJson(job.outDir, {
      triangles: result.triangles,
      resolution: result.resolution,
      backend: result.backend,
      source: job.sourceLabel,
    });
    console.log(`OK ${rel} — ${result.triangles} tris (${result.backend})`);
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
