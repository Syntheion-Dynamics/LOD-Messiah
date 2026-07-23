#!/usr/bin/env node
/**
 * Interaktivní výběr kitu z "Kitbash Assets" → convert / ship / obojí.
 *
 *   node scripts/kitbash-pick.js
 *   kitbash-pick.bat
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KITS_ROOT = join(ROOT, 'Kitbash Assets');
const OUTPUT = join(ROOT, 'output');

function listKits() {
  if (!existsSync(KITS_ROOT) || !statSync(KITS_ROOT).isDirectory()) {
    throw new Error(`Chybí složka: ${KITS_ROOT}`);
  }
  return readdirSync(KITS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => !n.startsWith('_') && !n.startsWith('.'))
    .sort((a, b) => a.localeCompare(b));
}

function countCooked(kit) {
  const kitDir = join(OUTPUT, kit);
  if (!existsSync(kitDir) || !statSync(kitDir).isDirectory()) return 0;
  return readdirSync(kitDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => !e.name.startsWith('_'))
    .filter((e) => existsSync(join(kitDir, e.name, 'lod0.glb')))
    .length;
}

function runNode(scriptRel, args) {
  const script = join(ROOT, scriptRel);
  console.log(`\n> node ${scriptRel} ${args.map(quoteArg).join(' ')}\n`);
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`Příkaz selhal (exit ${r.status ?? '?'})`);
  }
}

/** Windows-safe quote for logging only; spawn gets raw argv. */
function quoteArg(a) {
  if (/[\s"]/u.test(a)) return `"${a.replace(/"/g, '\\"')}"`;
  return a;
}

async function ask(rl, prompt, fallback = '') {
  const raw = (await rl.question(prompt)).trim();
  return raw === '' ? fallback : raw;
}

async function main() {
  const kits = listKits();
  if (!kits.length) {
    console.error('V Kitbash Assets není žádná složka.');
    process.exit(1);
  }

  const lod3Res = process.env.LOD3_RES || '2048';
  const jobs = process.env.CONVERT_JOBS || '7';

  console.log('============================================');
  console.log('  Kitbash pick — convert / ship');
  console.log('============================================');
  console.log(`Kits: ${KITS_ROOT}`);
  console.log(`LOD3_RES=${lod3Res}  CONVERT_JOBS=${jobs}`);
  console.log('');

  for (let i = 0; i < kits.length; i++) {
    const cooked = countCooked(kits[i]);
    const tag = cooked > 0 ? `${cooked} cooked` : 'neuvařeno';
    console.log(`  ${String(i + 1).padStart(2)}. ${kits[i]}  (${tag})`);
  }
  console.log(`  ${String(kits.length + 1).padStart(2)}. * VŠECHNY kity`);
  console.log('   0. Zrušit');
  console.log('');

  const rl = readline.createInterface({ input, output });
  try {
    const pickRaw = await ask(rl, `Vyber kit [1-${kits.length + 1}]: `);
    const pick = Number(pickRaw);
    if (!Number.isFinite(pick) || pick === 0) {
      console.log('Zrušeno.');
      return;
    }
    if (pick < 1 || pick > kits.length + 1) {
      console.error('Neplatné číslo.');
      process.exit(1);
    }

    const allKits = pick === kits.length + 1;
    const selected = allKits ? kits.slice() : [kits[pick - 1]];

    console.log('');
    console.log('Akce:');
    console.log('  1. Convert (uvařit LOD0–3)');
    console.log('  2. Ship do enginu');
    console.log('  3. Convert + Ship');
    console.log('  0. Zrušit');
    console.log('');

    const actRaw = await ask(rl, 'Vyber akci [1-3]: ');
    const act = Number(actRaw);
    if (!Number.isFinite(act) || act === 0) {
      console.log('Zrušeno.');
      return;
    }
    if (act < 1 || act > 3) {
      console.error('Neplatná akce.');
      process.exit(1);
    }

    const doConvert = act === 1 || act === 3;
    const doShip = act === 2 || act === 3;

    console.log('');
    console.log(
      `→ ${allKits ? 'VŠECHNY kity' : selected[0]}  |  ` +
        `${doConvert ? 'CONVERT' : ''}${doConvert && doShip ? ' + ' : ''}${doShip ? 'SHIP' : ''}`,
    );
    const conf = (await ask(rl, 'Pokračovat? [Y/n]: ', 'Y')).toLowerCase();
    if (conf === 'n' || conf === 'no' || conf === 'ne') {
      console.log('Zrušeno.');
      return;
    }

    if (doConvert) {
      for (const kit of selected) {
        console.log(`\n========== CONVERT ${kit} ==========`);
        // Volat cli.js přímo (ne npm) — cesty s mezerou ("Kitbash Assets") se nerozbijí.
        runNode('src/cli.js', [
          '--kits-root',
          KITS_ROOT,
          '--only',
          kit,
          '--output',
          OUTPUT,
          '--no-ktx2',
          '--max-texture',
          '2048',
          '--no-impostor',
          '--lod3-silhouette',
          '--lod3-res',
          String(lod3Res),
          '--shared-textures',
          '--jobs',
          String(jobs),
        ]);
      }
    }

    if (doShip) {
      if (allKits) {
        console.log('\n========== SHIP ALL ==========');
        runNode('scripts/ship-kit-to-engine.js', ['--all']);
      } else {
        for (const kit of selected) {
          console.log(`\n========== SHIP ${kit} ==========`);
          runNode('scripts/ship-kit-to-engine.js', [kit]);
        }
      }
    }

    console.log('\n============================================');
    console.log('Hotovo.');
    if (doShip) {
      console.log('Scéna: Buildings\\<Kit>\\<Asset>\\lod0.glb');
    }
    console.log('============================================');
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});
