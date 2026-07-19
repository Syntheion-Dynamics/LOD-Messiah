#!/usr/bin/env node
/**
 * Rebake octahedral impostors from default.glb (full mesh) at high res.
 * Falls back to lod0 if default missing / too small / external-only.
 *
 *   npm run rebake:impostors -- --force
 *   npm run rebake:impostors -- --force Manhattan Brooklyn
 *   IMPOSTOR_RES=4096 IMPOSTOR_FRAMES=16 npm run rebake:impostors -- --force
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateOctahedralImpostor } from '../legacy/impostor/octahedral.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'output');
const MIN_BYTES = 64 * 1024;
const ATLAS = Number(process.env.IMPOSTOR_RES || 4096);
const FRAMES = Number(process.env.IMPOSTOR_FRAMES || 16);

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const kitFilter = argv.filter((a) => a !== '--force');

function listAssetDirs() {
  if (!existsSync(OUTPUT)) return [];
  /** @type {string[]} */
  const dirs = [];

  for (const name of readdirSync(OUTPUT)) {
    if (name.startsWith('_') || name === 'node_modules') continue;
    const p = join(OUTPUT, name);
    if (!statSync(p).isDirectory()) continue;

    if (existsSync(join(p, 'lod0.glb')) || existsSync(join(p, 'default.glb'))) {
      dirs.push(p);
      continue;
    }

    if (kitFilter.length && !kitFilter.includes(name)) continue;
    for (const child of readdirSync(p)) {
      if (child.startsWith('_')) continue;
      const cp = join(p, child);
      if (!statSync(cp).isDirectory()) continue;
      if (existsSync(join(cp, 'lod0.glb')) || existsSync(join(cp, 'default.glb'))) {
        dirs.push(cp);
      }
    }
  }

  if (kitFilter.length) {
    return dirs.filter((d) =>
      kitFilter.some(
        (k) => d.includes(`${OUTPUT}\\${k}\\`) || d.includes(`${OUTPUT}/${k}/`),
      ),
    );
  }
  return dirs;
}

/** Prefer default.glb when it looks embedded (big enough); else lod0. */
function pickBakeSource(outDir) {
  const def = join(outDir, 'default.glb');
  const lod0 = join(outDir, 'lod0.glb');
  if (existsSync(def) && statSync(def).size >= MIN_BYTES) {
    // Tiny default usually means broken / external-only stub
    const head = readFileSync(def).subarray(0, Math.min(statSync(def).size, 2_000_000));
    const text = head.toString('latin1');
    const hasPng = /image\/png|image\/jpeg/.test(text);
    const hasKtx = /KHR_texture_basisu|KTX2/.test(text);
    if (hasPng && !hasKtx) {
      return { path: def, label: 'default' };
    }
  }
  if (existsSync(lod0) && statSync(lod0).size >= MIN_BYTES) {
    return { path: lod0, label: 'lod0' };
  }
  return null;
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
    source: meta.source || 'default',
  };
  writeFileSync(path, JSON.stringify(asset, null, 2));
}

const assets = listAssetDirs();
console.log(
  `KitBash impostor rebake — ${assets.length} candidate(s), ${ATLAS}px / ${FRAMES}×${FRAMES} (prefer default.glb)`,
);
if (!assets.length) {
  console.log('Nothing to do.');
  process.exit(0);
}

let ok = 0;
let skip = 0;
let fail = 0;

for (const outDir of assets) {
  const rel = outDir.slice(OUTPUT.length + 1);
  const src = pickBakeSource(outDir);
  if (!src) {
    console.log(`\nSKIP ${rel} — no default/lod0 bake source`);
    skip++;
    continue;
  }
  if (!force && existsSync(join(outDir, 'impostor.glb'))) {
    console.log(`\nSKIP ${rel} — impostor.glb exists (use --force)`);
    skip++;
    continue;
  }

  const mb = (statSync(src.path).size / (1024 * 1024)).toFixed(1);
  console.log(`\n→ ${rel} from ${src.label} (${mb} MB)`);
  const stageDir = join(tmpdir(), `hp-impostor-${Date.now()}-${ok + fail}`);
  mkdirSync(stageDir, { recursive: true });
  try {
    const result = await generateOctahedralImpostor({
      inputGlb: src.path,
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
      source: src.label,
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
