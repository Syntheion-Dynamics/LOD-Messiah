import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  extname,
  join,
  resolve,
  basename,
  relative,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SUPPORTED = new Set(['.glb', '.gltf', '.obj', '.fbx']);

/**
 * Recursively find supported 3D assets under a path (file or directory).
 * @param {string} inputPath
 * @returns {string[]}
 */
export function discoverAssets(inputPath) {
  const abs = resolve(inputPath);
  if (!existsSync(abs)) {
    throw new Error(`Input path does not exist: ${abs}`);
  }

  const st = statSync(abs);
  if (st.isFile()) {
    const ext = extname(abs).toLowerCase();
    if (!SUPPORTED.has(ext)) {
      throw new Error(`Unsupported file type: ${ext} (${abs})`);
    }
    return [abs];
  }

  const found = [];
  walk(abs, found);
  found.sort();
  return found;
}

/**
 * Discover assets from multiple roots (files and/or folders).
 * @param {string[]} inputPaths
 * @returns {string[]}
 */
export function discoverAssetsMany(inputPaths) {
  const set = new Set();
  for (const p of inputPaths) {
    for (const a of discoverAssets(p)) set.add(a);
  }
  return [...set].sort();
}

/**
 * List immediate kit subfolders under a kits root (e.g. Kitbash Assets/Manhattan).
 * @param {string} kitsRoot
 * @returns {{ name: string, path: string }[]}
 */
export function listKitFolders(kitsRoot) {
  const abs = resolve(kitsRoot);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`Kits root does not exist or is not a folder: ${abs}`);
  }
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .filter((d) => d.name !== 'node_modules' && d.name !== 'output')
    .map((d) => ({ name: d.name, path: join(abs, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // skip our own output/node_modules
      if (entry.name === 'node_modules' || entry.name === 'output') continue;
      walk(full, out);
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (SUPPORTED.has(ext)) out.push(full);
    }
  }
}

/**
 * Normalize any supported asset to a temporary/local GLB path.
 * @param {string} assetPath
 * @param {string} workDir
 * @param {{ blender?: string, gltfpack?: string }} tools
 * @returns {Promise<{ glbPath: string, sourceFormat: string, converted: boolean }>}
 */
export async function normalizeToGlb(assetPath, workDir, tools = {}) {
  const ext = extname(assetPath).toLowerCase();
  mkdirSync(workDir, { recursive: true });

  if (ext === '.glb') {
    const dest = join(workDir, 'source.glb');
    copyFileSync(assetPath, dest);
    return { glbPath: dest, sourceFormat: 'glb', converted: false };
  }

  if (ext === '.gltf') {
    // Keep sidecar resources: copy whole parent folder contents into workDir
    const parent = dirname(assetPath);
    const dest = join(workDir, 'source.gltf');
    copyTreeShallow(parent, workDir);
    // Rename primary if needed
    if (!existsSync(dest)) {
      copyFileSync(assetPath, dest);
    }
    // Prefer packing to GLB via gltfpack for a single binary
    const glbOut = join(workDir, 'source.glb');
    runGltfpack(dest, glbOut, tools.gltfpack);
    return { glbPath: glbOut, sourceFormat: 'gltf', converted: true };
  }

  if (ext === '.obj') {
    const glbOut = join(workDir, 'source.glb');
    runGltfpack(assetPath, glbOut, tools.gltfpack);
    return { glbPath: glbOut, sourceFormat: 'obj', converted: true };
  }

  if (ext === '.fbx') {
    const blender = resolveBlender(tools.blender);
    if (!blender) {
      throw new Error(
        `FBX requires Blender. Install Blender or set --blender path. File: ${assetPath}`,
      );
    }
    const glbOut = join(workDir, 'source.glb');
    runBlenderFbxToGlb(blender, assetPath, glbOut);
    return { glbPath: glbOut, sourceFormat: 'fbx', converted: true };
  }

  throw new Error(`Unsupported format: ${ext}`);
}

function copyTreeShallow(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    copyFileSync(join(srcDir, entry.name), join(destDir, entry.name));
  }
}

export function resolveBlender(explicit) {
  if (explicit && existsSync(explicit)) return explicit;

  // Project-local config (tools.config.json)
  const configPath = join(ROOT, 'tools.config.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      if (cfg.blender && existsSync(cfg.blender)) return cfg.blender;
    } catch {
      // ignore bad config
    }
  }

  const candidates = [
    process.env.BLENDER_PATH,
    'blender',
    // Prefer newest known installs; also scan Foundation folder below
    'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 5.0\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.4\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.1\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.0\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 3.6\\blender.exe',
    '/usr/bin/blender',
    '/Applications/Blender.app/Contents/MacOS/Blender',
  ].filter(Boolean);

  // Auto-discover any Blender Foundation\*\\blender.exe
  const foundation = 'C:\\Program Files\\Blender Foundation';
  if (existsSync(foundation)) {
    try {
      const versions = readdirSync(foundation, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(foundation, d.name, 'blender.exe'))
        .filter((p) => existsSync(p))
        // newest-looking first (lexicographic works for "Blender 5.1" > "Blender 4.2")
        .sort()
        .reverse();
      candidates.splice(2, 0, ...versions);
    } catch {
      // ignore
    }
  }

  for (const c of candidates) {
    if (c === 'blender') {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
      if (r.status === 0) return c;
      continue;
    }
    if (existsSync(c)) return c;
  }
  return null;
}

/** Resolve toktx.exe (KTX-Software). */
export function resolveToktx(explicit) {
  if (explicit && existsSync(explicit)) return explicit;

  const configPath = join(ROOT, 'tools.config.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      if (cfg.toktx && existsSync(cfg.toktx)) return cfg.toktx;
    } catch {
      // ignore
    }
  }

  const candidates = [
    process.env.TOKTX_PATH,
    'toktx',
    'C:\\Program Files\\KTX-Software\\bin\\toktx.exe',
    '/usr/bin/toktx',
    '/usr/local/bin/toktx',
  ].filter(Boolean);

  for (const c of candidates) {
    if (c === 'toktx') {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
      if (r.status === 0 || (r.stderr || r.stdout || '').includes('toktx')) {
        return c;
      }
      continue;
    }
    if (existsSync(c)) return c;
  }
  return null;
}

function resolveGltfpack(explicit) {
  if (explicit && existsSync(explicit)) return explicit;

  const localBin = join(
    ROOT,
    'node_modules',
    'meshoptimizer',
    'gltfpack',
  );
  // meshoptimizer npm may ship wasm/js only — try npx/gltfpack binary names
  const candidates = [
    process.env.GLTFPACK_PATH,
    localBin,
    join(ROOT, 'node_modules', '.bin', 'gltfpack'),
    join(ROOT, 'node_modules', '.bin', 'gltfpack.cmd'),
    'gltfpack',
  ].filter(Boolean);

  for (const c of candidates) {
    if (c === 'gltfpack') {
      const r = spawnSync(c, ['-v'], { encoding: 'utf8' });
      // gltfpack -v may exit 0
      if (r.status === 0 || (r.stdout || r.stderr || '').includes('gltfpack')) {
        return c;
      }
      continue;
    }
    if (existsSync(c)) return c;
  }
  return null;
}

function runGltfpack(input, output, explicitPath) {
  const bin = resolveGltfpack(explicitPath);
  if (!bin) {
    throw new Error(
      'gltfpack not found. Install meshoptimizer CLI/gltfpack or set --gltfpack. Needed for OBJ/GLTF conversion.',
    );
  }
  mkdirSync(dirname(output), { recursive: true });
  const r = spawnSync(bin, ['-i', input, '-o', output], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 || !existsSync(output)) {
    throw new Error(
      `gltfpack failed (${r.status}):\n${r.stderr || r.stdout || 'no output'}`,
    );
  }
}

function runBlenderFbxToGlb(blender, fbxPath, glbOut) {
  const script = join(ROOT, 'scripts', 'blender_fbx_to_glb.py');
  mkdirSync(dirname(glbOut), { recursive: true });
  const r = spawnSync(
    blender,
    [
      '--background',
      '--python',
      script,
      '--',
      '--input',
      fbxPath,
      '--output',
      glbOut,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0 || !existsSync(glbOut)) {
    throw new Error(
      `Blender FBX→GLB failed (${r.status}):\n${r.stderr || r.stdout || 'no output'}`,
    );
  }
}

/**
 * Optional normal-map bake: high GLB + low GLB → baked low GLB + normals PNG.
 */
export function runBlenderBakeNormals(options) {
  const {
    blender,
    highGlb,
    lowGlb,
    outputGlb,
    normalsPng,
    resolution = 2048,
  } = options;

  const bin = resolveBlender(blender);
  if (!bin) {
    throw new Error('Blender not found for --bake. Set --blender path.');
  }

  const script = join(ROOT, 'scripts', 'blender_bake_normals.py');
  mkdirSync(dirname(outputGlb), { recursive: true });

  const r = spawnSync(
    bin,
    [
      '--background',
      '--python',
      script,
      '--',
      '--high',
      highGlb,
      '--low',
      lowGlb,
      '--output',
      outputGlb,
      '--normals',
      normalsPng,
      '--resolution',
      String(resolution),
    ],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );

  if (r.status !== 0 || !existsSync(outputGlb)) {
    throw new Error(
      `Blender bake failed (${r.status}):\n${r.stderr || r.stdout || 'no output'}`,
    );
  }

  return { outputGlb, normalsPng, log: r.stdout || '' };
}

export function assetStem(assetPath, inputRoot) {
  const abs = resolve(assetPath);
  const root = resolve(inputRoot);
  let rel;
  try {
    rel = relative(root, abs);
    // Same file as --input, or path outside root → use basename
    if (!rel || rel === '.' || rel.startsWith('..')) {
      rel = basename(abs);
    }
  } catch {
    rel = basename(abs);
  }
  const noExt = rel.replace(/\.(glb|gltf|obj|fbx)$/i, '');
  // Nested folders under output (Kit/Asset), not flat Kit__Asset names
  return noExt.replace(/\\/g, '/').replace(/\/+/g, '/') || 'asset';
}

export function makeWorkDir(baseOut) {
  return mkdtempSync(join(tmpdir(), 'hp-pipeline-'));
}

export { ROOT, SUPPORTED };
