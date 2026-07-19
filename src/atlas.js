import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveBlender, ROOT } from './convert.js';

/**
 * Run Blender material→atlas bake.
 * @param {object} options
 * @param {string} options.inputGlb
 * @param {string} options.outputGlb
 * @param {string} options.mapsDir
 * @param {number} [options.resolution]
 * @param {string|null} [options.blender]
 */
export function runAtlasBake(options) {
  const {
    inputGlb,
    outputGlb,
    mapsDir,
    resolution = 1024,
    blender = null,
  } = options;

  const bin = resolveBlender(blender);
  if (!bin) {
    throw new Error(
      'Atlas bake needs Blender. Set tools.config.json blender path or --blender.',
    );
  }

  mkdirSync(mapsDir, { recursive: true });
  mkdirSync(dirname(outputGlb), { recursive: true });

  const script = join(ROOT, 'scripts', 'blender_atlas_bake.py');
  console.log(
    `  atlas   : Blender bake ${resolution}px → 1 material (albedo/normal/ORM)`,
  );

  const r = spawnSync(
    bin,
    [
      '--background',
      '--python',
      script,
      '--',
      '--input',
      inputGlb,
      '--output',
      outputGlb,
      '--faces-dir',
      mapsDir,
      '--resolution',
      String(resolution),
    ],
    {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    },
  );

  // Blender often prints to stdout; surface last lines on failure
  if (r.status !== 0 || !existsSync(outputGlb)) {
    const log = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    throw new Error(
      `Atlas bake failed (${r.status}):\n${log.slice(-4000) || 'no output'}`,
    );
  }

  return { outputGlb, mapsDir, resolution, backend: 'blender' };
}
