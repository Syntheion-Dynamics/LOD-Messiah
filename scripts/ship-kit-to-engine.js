#!/usr/bin/env node
/**
 * Ship všechny cooked assety jednoho kitu → Bungáč Assets/Buildings/<Kit>/<Asset>/
 *
 * Usage:
 *   node scripts/ship-kit-to-engine.js Manhattan
 *   node scripts/ship-kit-to-engine.js Manhattan --dry-run
 *   node scripts/ship-kit-to-engine.js Brooklyn
 *
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

function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--no-pause');
  const dryRun = args.includes('--dry-run');
  const noDefault = args.includes('--no-default');
  const kitName = args.find((a) => !a.startsWith('--'));

  if (!kitName || args.includes('-h') || args.includes('--help')) {
    console.log('Usage: node scripts/ship-kit-to-engine.js <Kit> [--dry-run] [--no-default]');
    console.log('       node scripts/ship-kit-to-engine.js Manhattan');
    console.log('       node scripts/ship-kit-to-engine.js Manhattan --no-default');
    process.exit(kitName ? 0 : 1);
  }

  const assets = listKitAssets(kitName);
  const sharedInfo = describeKitShared(kitName);

  console.log('============================================');
  console.log(`  Ship kit → Bungáč  (${dryRun ? 'DRY-RUN' : 'LIVE'})`);
  console.log('============================================');
  console.log(`Kit:    ${kitName}`);
  console.log(`Assets: ${assets.length}`);
  if (noDefault) console.log('Mode:   --no-default');
  console.log('');

  if (assets.length === 0) {
    console.log('Nic ke shipnutí (žádná podsložka s lod0.glb).');
    process.exit(1);
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
    console.log(
      sharedInfo.present
        ? '_shared se zkopíruje JEDNOU (ne u každé budovy).'
        : '',
    );
    console.log('Až budeš ready: ship-manhattan-to-engine.bat  (bez --dry-run)');
    return;
  }

  let ok = 0;
  let failed = 0;
  let totalBytes = 0;
  const failures = [];

  // Kit shared pool — once, before per-asset ship (assets use skipShared).
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
  console.log(`  Hotovo: ${ok} OK, ${failed} fail, ${formatBytes(totalBytes)}`);
  if (sharedResult.copied) {
    console.log(`  _shared: copied once (${formatBytes(sharedResult.bytes)})`);
  }
  console.log('============================================');
  if (failures.length > 0) {
    for (const f of failures) {
      console.log(`  FAIL  ${f.rel}: ${f.message}`);
    }
    process.exit(1);
  }
  console.log(`Cíl: Assets/Buildings/${kitName}/<Asset>/lod0.glb`);
  console.log(`     Assets/Buildings/${kitName}/_shared/textures/`);
  console.log('(Skipped per asset: impostor.*, preview, report)');
}

try {
  main();
} catch (err) {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
}
