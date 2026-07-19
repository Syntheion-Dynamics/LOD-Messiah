#!/usr/bin/env node
/**
 * Ship cooked LOD Messiah asset → Bungáč Assets/Buildings/<Kit>/<Asset>/
 *
 * Day-1 files only (engine LOD chain). Skips default.glb, impostor, gallery junk.
 *
 * Usage:
 *   node scripts/ship-to-engine.js Manhattan/Office_Plaza
 *   node scripts/ship-to-engine.js Office_Plaza
 *   BUNGAC_ASSETS=... node scripts/ship-to-engine.js Manhattan/Office_Plaza
 *
 * Env / tools.config.json:
 *   BUNGAC_ASSETS — absolute path to engine Assets/ folder
 *   tools.config.json → "bungacAssets"
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

const DAY1_FILES = ['lod0.glb', 'lod1.glb', 'lod2.glb', 'lod3.glb', 'asset.json'];
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

function ship(relArg) {
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
  console.log('');

  let copiedBytes = 0;
  const copied = [];

  for (const name of DAY1_FILES) {
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

  console.log('');
  console.log(`Shipped ${copied.length} item(s), ${formatBytes(copiedBytes)}`);
  console.log(`Scene modelPath: Buildings/${relativeKey.replace(/\\/g, '/')}/lod0.glb`);
  console.log('(Skipped: default.glb, impostor.*, preview.html, report.json)');
  return { destDir, relativeKey, copiedBytes };
}

const arg = process.argv[2];
if (!arg || arg === '-h' || arg === '--help') {
  console.log(`Usage: node scripts/ship-to-engine.js <Kit>/<Asset>`);
  console.log(`       node scripts/ship-to-engine.js Manhattan/Office_Plaza`);
  console.log(`Env:   BUNGAC_ASSETS = absolute path to engine Assets/`);
  process.exit(arg ? 0 : 1);
}

try {
  ship(arg);
} catch (err) {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
}
