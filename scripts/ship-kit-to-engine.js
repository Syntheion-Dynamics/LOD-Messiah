#!/usr/bin/env node
/**
 * Ship všechny cooked assety jednoho kitu → Bungáč Assets/Buildings/<Kit>/<Asset>/
 *
 * Usage:
 *   node scripts/ship-kit-to-engine.js Manhattan
 *   node scripts/ship-kit-to-engine.js Manhattan --dry-run
 *   node scripts/ship-kit-to-engine.js Brooklyn
 *   node scripts/ship-kit-to-engine.js --all
 *
 * --all: všechny složky v "Kitbash Assets" (které mají cooked output/<Kit>/).
 * Přeskočí složky bez lod0.glb a interný junk (_shared, _textures, _lod3_*, …).
 * Kit `_shared/` se kopíruje JEDNOU (ne per budova).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeKitShared,
  ship,
  shipKitShared,
} from './ship-to-engine.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'output');
const KITS_ROOT = join(ROOT, 'Kitbash Assets');

/** Složky přímo pod Kitbash Assets (Arch Vogue, Manhattan, …). */
function listKitbashKitNames() {
  if (!existsSync(KITS_ROOT) || !statSync(KITS_ROOT).isDirectory()) {
    throw new Error(`Kitbash Assets folder not found: ${KITS_ROOT}`);
  }
  return readdirSync(KITS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('_') && !name.startsWith('.'))
    .sort((a, b) => a.localeCompare(b));
}

function listKitAssets(kitName) {
  const kitDir = join(OUTPUT, kitName);
  if (!existsSync(kitDir) || !statSync(kitDir).isDirectory()) {
    throw new Error(
      `Kit folder not found: ${kitDir}\n` +
        `Cook first (convert-kitbash-all.bat ${kitName}), then ship.`,
    );
  }

  const names = readdirSync(kitDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('_'))
    .filter((name) => existsSync(join(kitDir, name, 'lod0.glb')))
    .sort((a, b) => a.localeCompare(b));

  return names;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {string} kitName
 * @param {{ dryRun: boolean, noDefault: boolean }} opts
 * @returns {{ ok: number, failed: number, bytes: number, skipped: boolean }}
 */
function shipOneKit(kitName, { dryRun, noDefault }) {
  let assets;
  try {
    assets = listKitAssets(kitName);
  } catch (err) {
    console.log(`\n--- ${kitName} ---`);
    console.log(`SKIP ${kitName}: ${err.message}`);
    return { ok: 0, failed: 0, bytes: 0, skipped: true };
  }

  const sharedInfo = describeKitShared(kitName);

  console.log('\n============================================');
  console.log(`  Ship kit → Bungáč  (${dryRun ? 'DRY-RUN' : 'LIVE'})`);
  console.log('============================================');
  console.log(`Kit:    ${kitName}`);
  console.log(`Assets: ${assets.length}`);
  if (noDefault) console.log('Mode:   --no-default');
  console.log('');

  if (assets.length === 0) {
    console.log(`SKIP ${kitName}: žádná podsložka s lod0.glb (neuvařené?).`);
    return { ok: 0, failed: 0, bytes: 0, skipped: true };
  }

  if (sharedInfo.present) {
    console.log(
      `  copy  _shared/ (once)  ${formatBytes(sharedInfo.bytes)} → Buildings/${kitName}/_shared/`,
    );
  } else {
    console.log(`  skip  _shared/ (not present — cook with --shared-textures)`);
  }

  for (const name of assets) {
    console.log(`  - ${kitName}/${name}`);
  }
  console.log('');

  if (dryRun) {
    console.log('Dry-run — nic se nezkopírovalo.');
    return { ok: assets.length, failed: 0, bytes: 0, skipped: false };
  }

  let ok = 0;
  let failed = 0;
  let totalBytes = 0;
  const failures = [];

  const sharedResult = shipKitShared(kitName);
  if (sharedResult.copied) {
    totalBytes += sharedResult.bytes;
  }
  console.log('');

  for (const name of assets) {
    const rel = `${kitName}/${name}`;
    try {
      const result = ship(rel, { noDefault, skipShared: true });
      ok += 1;
      totalBytes += result.copiedBytes;
      console.log('');
    } catch (err) {
      failed += 1;
      failures.push({ rel, message: err.message });
      console.error(`\nERROR ${rel}: ${err.message}\n`);
    }
  }

  console.log('============================================');
  console.log(`  Hotovo ${kitName}: ${ok} OK, ${failed} fail, ${formatBytes(totalBytes)}`);
  if (sharedResult.copied) {
    console.log(`  _shared: copied once (${formatBytes(sharedResult.bytes)})`);
  }
  console.log('============================================');
  if (failures.length > 0) {
    for (const f of failures) {
      console.log(`  FAIL  ${f.rel}: ${f.message}`);
    }
  }
  console.log(`Cíl: Assets/Buildings/${kitName}/<Asset>/lod0.glb`);
  console.log(`     Assets/Buildings/${kitName}/_shared/textures/`);
  console.log('(Skipped per asset: impostor.*, preview, report)');

  return { ok, failed, bytes: totalBytes, skipped: false };
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--no-pause');
  const dryRun = args.includes('--dry-run');
  const noDefault = args.includes('--no-default');
  const shipAll = args.includes('--all');
  const kitName = args.find((a) => !a.startsWith('--'));

  if (args.includes('-h') || args.includes('--help')) {
    console.log('Usage: node scripts/ship-kit-to-engine.js <Kit> [--dry-run] [--no-default]');
    console.log('       node scripts/ship-kit-to-engine.js --all [--dry-run] [--no-default]');
    console.log('       node scripts/ship-kit-to-engine.js Manhattan');
    console.log('       node scripts/ship-kit-to-engine.js Manhattan --no-default');
    process.exit(0);
  }

  if (shipAll) {
    const kits = listKitbashKitNames();
    console.log('============================================');
    console.log(`  Ship ALL Kitbash Assets → Bungáč`);
    console.log(`  (${dryRun ? 'DRY-RUN' : 'LIVE'})`);
    console.log('============================================');
    console.log(`Kits root: Kitbash Assets\\ (${kits.length})`);
    for (const k of kits) console.log(`  - ${k}`);
    console.log('');

    let ok = 0;
    let failed = 0;
    let skipped = 0;
    let bytes = 0;
    const shipped = [];
    const skippedNames = [];

    for (const kit of kits) {
      const r = shipOneKit(kit, { dryRun, noDefault });
      if (r.skipped) {
        skipped += 1;
        skippedNames.push(kit);
        continue;
      }
      ok += r.ok;
      failed += r.failed;
      bytes += r.bytes;
      shipped.push(kit);
    }

    console.log('\n============================================');
    console.log(
      `  ALL DONE: ${shipped.length} kit(s) shipped, ${skipped} skipped, ` +
        `${ok} assets OK, ${failed} fail, ${formatBytes(bytes)}`,
    );
    if (shipped.length) console.log(`  Shipped: ${shipped.join(', ')}`);
    if (skippedNames.length) {
      console.log(`  Skipped (no cooked lod0): ${skippedNames.join(', ')}`);
    }
    console.log('============================================');
    if (failed > 0 || shipped.length === 0) process.exit(1);
    return;
  }

  if (!kitName) {
    console.log('Usage: node scripts/ship-kit-to-engine.js <Kit> [--dry-run] [--no-default]');
    console.log('       node scripts/ship-kit-to-engine.js --all');
    process.exit(1);
  }

  const r = shipOneKit(kitName, { dryRun, noDefault });
  if (r.skipped || r.failed > 0) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
}
