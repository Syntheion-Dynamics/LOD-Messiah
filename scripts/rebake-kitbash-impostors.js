#!/usr/bin/env node
/**
 * Rebake octahedral impostors for already-cooked KitBash folders under output/.
 * Skips broken/empty lod0 and assets that already have impostor.glb (unless --force).
 *
 *   node scripts/rebake-kitbash-impostors.js
 *   node scripts/rebake-kitbash-impostors.js Manhattan Brooklyn
 *   node scripts/rebake-kitbash-impostors.js --force
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateOctahedralImpostor } from '../src/octahedral.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'output');
const MIN_LOD0_BYTES = 64 * 1024; // skip empty / broken cooks
const ATLAS = Number(process.env.IMPOSTOR_RES || 2048);
const FRAMES = Number(process.env.IMPOSTOR_FRAMES || 12);

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const kitFilter = argv.filter((a) => a !== '--force');

function listAssetDirs() {
  if (!existsSync(OUTPUT)) return [];

  /** @type {string[]} */
  const dirs = [];

  // Flat cooks: output/Office_Plaza/
  for (const name of readdirSync(OUTPUT)) {
    if (name.startsWith('_') || name === 'node_modules') continue;
    const p = join(OUTPUT, name);
    if (!statSync(p).isDirectory()) continue;

    const lod0 = join(p, 'lod0.glb');
    if (existsSync(lod0)) {
      dirs.push(p);
      continue;
    }

    // Kit layout: output/Manhattan/Office_Plaza/
    if (kitFilter.length && !kitFilter.includes(name)) continue;
    for (const child of readdirSync(p)) {
      if (child.startsWith('_')) continue;
      const cp = join(p, child);
      if (!statSync(cp).isDirectory()) continue;
      if (existsSync(join(cp, 'lod0.glb'))) dirs.push(cp);
    }
  }

  // If kit filter set, drop flat dirs that aren't under those kits
  if (kitFilter.length) {
    return dirs.filter((d) => kitFilter.some((k) => d.includes(`${OUTPUT}\\${k}\\`) || d.includes(`${OUTPUT}/${k}/`)));
  }
  return dirs;
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
  asset.impostor = {
    ok: true,
    file: 'impostor.glb',
    atlas: 'impostor_atlas.png',
    frames: meta.frames ?? FRAMES,
    hemi: meta.hemi !== false,
    resolution: meta.atlasSize ?? ATLAS,
    mode: 'octahedral',
  };
  writeFileSync(path, JSON.stringify(asset, null, 2));
}

const assets = listAssetDirs();
console.log(`KitBash impostor rebake — ${assets.length} candidate(s), ${ATLAS}px / ${FRAMES}×${FRAMES}`);
if (!assets.length) {
  console.log('Nothing to do.');
  process.exit(0);
}

let ok = 0;
let skip = 0;
let fail = 0;

for (const outDir of assets) {
  const rel = outDir.slice(OUTPUT.length + 1);
  const lod0 = join(outDir, 'lod0.glb');
  const bytes = statSync(lod0).size;
  if (bytes < MIN_LOD0_BYTES) {
    console.log(`\nSKIP ${rel} — lod0 too small (${bytes} B), re-convert first`);
    skip++;
    continue;
  }
  if (!force && existsSync(join(outDir, 'impostor.glb'))) {
    console.log(`\nSKIP ${rel} — impostor.glb exists (use --force)`);
    skip++;
    continue;
  }

  console.log(`\n→ ${rel} (lod0 ${(bytes / (1024 * 1024)).toFixed(1)} MB)`);
  const stageDir = join(tmpdir(), `hp-impostor-${Date.now()}-${ok + fail}`);
  mkdirSync(stageDir, { recursive: true });
  try {
    const result = await generateOctahedralImpostor({
      inputGlb: lod0,
      outputGlb: join(outDir, 'impostor.glb'),
      outDir,
      stageDir,
      atlasSize: ATLAS,
      frames: FRAMES,
      hemi: true,
    });
    patchAssetJson(outDir, {
      frames: result.frames,
      atlasSize: result.atlasSize,
      hemi: true,
    });
    console.log(`  OK ${rel}`);
    ok++;
  } catch (err) {
    console.error(`  FAIL ${rel}: ${err.message}`);
    if (err.stack) console.error(err.stack);
    fail++;
    const path = join(outDir, 'asset.json');
    if (existsSync(path)) {
      try {
        const asset = JSON.parse(readFileSync(path, 'utf8'));
        asset.impostor = { ok: false, reason: err.message };
        writeFileSync(path, JSON.stringify(asset, null, 2));
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      rmSync(stageDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

console.log(`\nDone. OK=${ok} skip=${skip} fail=${fail}`);
process.exit(fail ? 1 : 0);
