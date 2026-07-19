#!/usr/bin/env node
/**
 * Ship cooked LOD Messiah asset → Bungáč Assets/Buildings/<Kit>/<Asset>/
 *
 * Day-1: default.glb (optional close-up) + lod0..3 + asset.json + atlases.
 * Skips impostor, gallery junk. Use --no-default to omit heavy default.glb.
 *
 * Usage:
 *   node scripts/ship-to-engine.js Manhattan/Office_Plaza
 *   node scripts/ship-to-engine.js Manhattan/Office_Plaza --no-default
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'output');

const DAY1_FILES = ['default.glb', 'lod0.glb', 'lod1.glb', 'lod2.glb', 'lod3.glb', 'asset.json'];
const DAY1_DIRS = ['lod2_atlas', 'lod3_atlas'];

function loadConfig() {
  const path = join(ROOT, 'tools.config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function resolveAssetsRoot() {
  if (process.env.BUNGAC_ASSETS) {
    return resolve(process.env.BUNGAC_ASSETS);
  }
  const cfg = loadConfig();
  if (cfg.bungacAssets) {
    return resolve(ROOT, cfg.bungacAssets);
  }
  // Fallback: Downloads/TOOL → Documents/.../GTA/Assets (same user profile)
  return resolve(
    ROOT,
    '..',
    '..',
    'Documents',
    'PROJEKT X',
    'Programming Projects',
    'GTA',
    'Assets',
  );
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function dirSize(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else total += statSync(p).size;
  }
  return total;
}

function resolveSourceDir(relArg) {
  const cleaned = normalize(relArg.replace(/\\/g, '/')).replace(/^[/\\]+/, '');
  const candidate = join(OUTPUT, cleaned);
  if (existsSync(join(candidate, 'lod0.glb'))) {
    return { sourceDir: candidate, relativeKey: cleaned };
  }

  // Flat fallback: output/Office_Plaza
  const parts = cleaned.split(/[/\\]/).filter(Boolean);
  if (parts.length === 2) {
    const flat = join(OUTPUT, parts[1]);
    if (existsSync(join(flat, 'lod0.glb'))) {
      return { sourceDir: flat, relativeKey: cleaned };
    }
  }

  throw new Error(
    `Cooked asset not found: ${candidate}\n` +
      `Expected lod0.glb under output/<Kit>/<Asset>/ (or flat output/<Asset>/).\n` +
      `Cook first, then ship.`,
  );
}

/**
 * Copy kit-level `_shared/` (textures pool) once → Assets/Buildings/<Kit>/_shared/.
 * Idempotent: replaces destination folder if present.
 * @returns {{ copied: boolean, bytes: number, dest: string|null, source: string|null }}
 */
export function shipKitShared(kitName, options = {}) {
  const quiet = options.quiet === true;
  const assetsRoot = resolveAssetsRoot();
  if (!existsSync(assetsRoot)) {
    throw new Error(
      `Engine Assets folder not found: ${assetsRoot}\n` +
        `Set BUNGAC_ASSETS or tools.config.json "bungacAssets".`,
    );
  }

  const sourceDir = join(OUTPUT, kitName, '_shared');
  const destDir = join(assetsRoot, 'Buildings', kitName, '_shared');

  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    if (!quiet) {
      console.log(`  skip  _shared/ (not present under output/${kitName}/)`);
    }
    return { copied: false, bytes: 0, dest: null, source: null };
  }

  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(sourceDir, destDir, { recursive: true });
  const bytes = dirSize(sourceDir);
  if (!quiet) {
    console.log(
      `  copy  _shared/  (${formatBytes(bytes)}) → Buildings/${kitName}/_shared/  (once per kit)`,
    );
  }
  return { copied: true, bytes, dest: destDir, source: sourceDir };
}

/** Describe kit `_shared/` for dry-run (no copy). */
export function describeKitShared(kitName) {
  const sourceDir = join(OUTPUT, kitName, '_shared');
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    return { present: false, bytes: 0, source: null };
  }
  return { present: true, bytes: dirSize(sourceDir), source: sourceDir };
}

export function ship(relArg, options = {}) {
  const skipDefault = options.noDefault === true;
  const skipShared = options.skipShared === true;
  const { sourceDir, relativeKey } = resolveSourceDir(relArg);
  const assetsRoot = resolveAssetsRoot();
  if (!existsSync(assetsRoot)) {
    throw new Error(
      `Engine Assets folder not found: ${assetsRoot}\n` +
        `Set BUNGAC_ASSETS or tools.config.json "bungacAssets".`,
    );
  }

  const destDir = join(assetsRoot, 'Buildings', ...relativeKey.split(/[/\\]/).filter(Boolean));
  mkdirSync(destDir, { recursive: true });

  console.log('============================================');
  console.log('  LOD Messiah → Bungáč (day-1 ship)');
  console.log('============================================');
  console.log(`Source: ${sourceDir}`);
  console.log(`Dest:   ${destDir}`);
  if (skipDefault) console.log('Mode:   --no-default (skip default.glb)');
  console.log('');

  let copiedBytes = 0;
  const copied = [];

  // Single-asset ship: ensure kit `_shared/` exists next to the building (idempotent).
  const parts = relativeKey.split(/[/\\]/).filter(Boolean);
  if (!skipShared && parts.length >= 2) {
    const sharedResult = shipKitShared(parts[0], { quiet: false });
    if (sharedResult.copied) {
      copiedBytes += sharedResult.bytes;
      copied.push('_shared/');
    }
  }

  for (const name of DAY1_FILES) {
    if (skipDefault && name === 'default.glb') {
      const staleDefault = join(destDir, 'default.glb');
      if (existsSync(staleDefault)) {
        rmSync(staleDefault, { force: true });
        console.log('  clean default.glb (stale, --no-default)');
      } else {
        console.log('  skip  default.glb (--no-default)');
      }
      continue;
    }
    const src = join(sourceDir, name);
    if (!existsSync(src)) {
      if (name === 'lod0.glb') {
        throw new Error(`Missing required ${name} in ${sourceDir}`);
      }
      console.log(`  skip  ${name} (not present)`);
      continue;
    }
    const dest = join(destDir, name);
    copyFileSync(src, dest);
    const size = statSync(src).size;
    copiedBytes += size;
    copied.push(name);
    console.log(`  copy  ${name}  (${formatBytes(size)})`);
  }

  for (const name of DAY1_DIRS) {
    const src = join(sourceDir, name);
    const dest = join(destDir, name);
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      if (existsSync(dest)) {
        rmSync(dest, { recursive: true, force: true });
        console.log(`  clean ${name}/ (stale, not in cook)`);
      } else {
        console.log(`  skip  ${name}/ (not present)`);
      }
      continue;
    }
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
    }
    cpSync(src, dest, { recursive: true });
    const size = dirSize(src);
    copiedBytes += size;
    copied.push(`${name}/`);
    console.log(`  copy  ${name}/  (${formatBytes(size)})`);
  }

  // Stale raw KitBash next to cooked folder = „3 budovy v sobě“ v asset browseru.
  // Příklad: Assets/Buildings/Manhattan/Office_Plaza.glb vedle Office_Plaza/lod0.glb
  const cleanedStale = cleanStaleSiblings(assetsRoot, relativeKey);

  console.log('');
  console.log(`Shipped ${copied.length} item(s), ${formatBytes(copiedBytes)}`);
  console.log(`Scene modelPath: Buildings/${relativeKey.replace(/\\/g, '/')}/lod0.glb`);
  console.log('(Engine: default.glb vedle lod0 = close-up LOD0; skipped impostor/preview/report)');
  if (cleanedStale.length > 0) {
    console.log(`(Cleaned stale: ${cleanedStale.join(', ')})`);
  }
  return { destDir, relativeKey, copiedBytes, cleanedStale };
}

/**
 * Smaže konfliktní raw .glb / prefab / preview vedle cooked složky
 * a flat duplicitu Assets/Buildings/<Asset>/ když shipujeme Kit/Asset.
 */
function cleanStaleSiblings(assetsRoot, relativeKey) {
  const cleaned = [];
  const parts = relativeKey.split(/[/\\]/).filter(Boolean);
  const assetName = parts[parts.length - 1];
  const kitDir =
    parts.length >= 2
      ? join(assetsRoot, 'Buildings', ...parts.slice(0, -1))
      : join(assetsRoot, 'Buildings');

  const siblingBases = [
    join(kitDir, assetName),
    // Flat leftover: Assets/Buildings/Office_Plaza/ vedle Manhattan/Office_Plaza/
    parts.length >= 2 ? join(assetsRoot, 'Buildings', assetName) : null,
  ].filter(Boolean);

  const looseExts = ['.glb', '.prefab.json', '.preview.png'];

  for (const base of siblingBases) {
    // Loose file: …/Office_Plaza.glb (NE složka …/Office_Plaza/)
    for (const ext of looseExts) {
      const loose = base + ext;
      if (existsSync(loose) && statSync(loose).isFile()) {
        rmSync(loose, { force: true });
        cleaned.push(loose.replace(assetsRoot, 'Assets'));
        console.log(`  clean stale ${loose.replace(assetsRoot, 'Assets')}`);
      }
    }

    // Flat duplicate folder only when we shipped nested Kit/Asset
    // (base === Assets/Buildings/Office_Plaza while dest is …/Manhattan/Office_Plaza)
    const nestedDest = join(assetsRoot, 'Buildings', ...parts);
    if (parts.length >= 2 && base !== nestedDest && existsSync(base) && statSync(base).isDirectory()) {
      // Only remove if it looks like a cooked/flat ship leftover (has lod0 or asset.json)
      const looksLikeCooked =
        existsSync(join(base, 'lod0.glb')) || existsSync(join(base, 'asset.json'));
      if (looksLikeCooked) {
        rmSync(base, { recursive: true, force: true });
        cleaned.push(base.replace(assetsRoot, 'Assets') + '/');
        console.log(`  clean flat duplicate ${base.replace(assetsRoot, 'Assets')}/`);
      }
    }
  }

  return cleaned;
}

import { pathToFileURL } from 'node:url';

const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const args = process.argv.slice(2);
  const noDefault = args.includes('--no-default');
  const arg = args.find((a) => !a.startsWith('--'));
  if (!arg || args.includes('-h') || args.includes('--help')) {
    console.log(`Usage: node scripts/ship-to-engine.js <Kit>/<Asset> [--no-default]`);
    console.log(`       node scripts/ship-to-engine.js Manhattan/Office_Plaza`);
    console.log(`       node scripts/ship-to-engine.js Manhattan/Office_Plaza --no-default`);
    console.log(`Env:   BUNGAC_ASSETS = absolute path to engine Assets/`);
    process.exit(arg ? 0 : 1);
  }

  try {
    ship(arg, { noDefault });
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    process.exit(1);
  }
}
