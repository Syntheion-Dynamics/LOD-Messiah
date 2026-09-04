#!/usr/bin/env node
/**
 * Asset Library scanner — builds library-index.json from:
 *   - engine Assets/Buildings (asset.json + optional GLB dims)
 *   - TOOL output/ (cooked source for thumbs / live 3D)
 *   - Assets/scene.json (usage)
 *   - optional Kitbash Assets/ (E6 source_only)
 *
 * Read-only toward the engine repo. Writes only into TOOL/.
 *
 * Usage:
 *   node src/library-index.js
 *   node src/library-index.js --no-dims
 *   node src/library-index.js --with-source
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readGlbWorldMeta } from './lib/glb-meta.js';
import {
  assessLodChain,
  attachPercentiles,
} from './library-health.js';
import { scanVehicles } from './library-index-vehicles.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(ROOT, 'library-index.json');
const PREV_INDEX_PATH = join(ROOT, 'library-index.json');

function loadConfig() {
  const path = join(ROOT, 'tools.config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function resolveAssetsRoot() {
  if (process.env.BUNGAC_ASSETS) return resolve(process.env.BUNGAC_ASSETS);
  const cfg = loadConfig();
  if (cfg.bungacAssets) return resolve(ROOT, cfg.bungacAssets);
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

export function resolveOutputRoot() {
  return resolve(ROOT, 'output');
}

export function resolveKitbashRoot() {
  if (process.env.KITBASH_ASSETS) return resolve(process.env.KITBASH_ASSETS);
  return resolve(ROOT, 'Kitbash Assets');
}

function dirSizeBytes(path) {
  let total = 0;
  if (!existsSync(path)) return 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else total += statSync(p).size;
  }
  return total;
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Normalize folder/file name for cross-root matching. */
export function normalizeName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/manthattan/g, 'manhattan')
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^(kb3d|kitbash)/, '');
}

function loadPreviousFirstSeen() {
  const prev = safeReadJson(PREV_INDEX_PATH);
  const map = new Map();
  if (!prev) return map;

  if (prev.schemaVersion >= 2 && prev.catalogs) {
    for (const cat of Object.values(prev.catalogs)) {
      for (const a of cat.assets || []) {
        if (a.id && a.first_seen) map.set(a.id, a.first_seen);
      }
    }
    return map;
  }

  for (const a of prev.assets || []) {
    if (a.id && a.first_seen) map.set(a.id, a.first_seen);
  }
  return map;
}

/**
 * Walk Assets/Buildings for cooked assets (folders with asset.json)
 * and raw loose .glb files.
 */
function scanEngineBuildings(assetsRoot, { readDims }) {
  const buildingsRoot = join(assetsRoot, 'Buildings');
  const cooked = [];
  const raw = [];
  if (!existsSync(buildingsRoot)) return { cooked, raw };

  function walkKit(kitDir, kitName) {
    for (const entry of readdirSync(kitDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) {
        continue;
      }
      const assetDir = join(kitDir, entry.name);
      const assetJsonPath = join(assetDir, 'asset.json');
      if (existsSync(assetJsonPath)) {
        cooked.push(readCookedAsset(kitName, entry.name, assetDir, { readDims }));
        continue;
      }
      // Nested kit? (shouldn't happen) or raw folder with glbs
      walkRawFolder(assetDir, `${kitName}/${entry.name}`, raw);
    }

    // Loose .glb directly under kit
    for (const entry of readdirSync(kitDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.glb')) continue;
      const name = entry.name.replace(/\.glb$/i, '');
      raw.push({
        id: `${kitName}/${name}`,
        catalog: 'buildings',
        kit: kitName,
        name,
        state: 'raw_bez_cooku',
        engine_path: relative(assetsRoot, join(kitDir, entry.name)).replace(/\\/g, '/'),
        file_bytes: statSync(join(kitDir, entry.name)).size,
      });
    }
  }

  function walkRawFolder(dir, relKey, out) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('_')) {
        const nested = join(dir, entry.name);
        if (existsSync(join(nested, 'asset.json'))) {
          const parts = relKey.split('/');
          cooked.push(
            readCookedAsset(parts[0] || 'Unknown', entry.name, nested, { readDims }),
          );
        } else {
          walkRawFolder(nested, `${relKey}/${entry.name}`, out);
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.glb')) continue;
      const name = entry.name.replace(/\.glb$/i, '');
      out.push({
        id: `${relKey}/${name}`,
        catalog: 'buildings',
        kit: relKey.split('/')[0] || 'Unknown',
        name,
        state: 'raw_bez_cooku',
        engine_path: relative(assetsRoot, join(dir, entry.name)).replace(/\\/g, '/'),
        file_bytes: statSync(join(dir, entry.name)).size,
      });
    }
  }

  for (const entry of readdirSync(buildingsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) {
      continue;
    }
    walkKit(join(buildingsRoot, entry.name), entry.name);
  }

  return { cooked, raw };
}

function readCookedAsset(kit, name, assetDir, { readDims }) {
  const id = `${kit}/${name}`;
  const assetJson = safeReadJson(join(assetDir, 'asset.json')) || {};
  const lods = Array.isArray(assetJson.lods)
    ? assetJson.lods.map((l) => ({
        level: l.level,
        file: l.file || `lod${l.level}.glb`,
        triangles: typeof l.triangles === 'number' ? l.triangles : null,
        atlas: !!l.atlas,
        exists: existsSync(join(assetDir, l.file || `lod${l.level}.glb`)),
      }))
    : [];

  // Ensure default slot if present
  const hasDefault = existsSync(join(assetDir, 'default.glb'));
  const files = {
    default_glb: hasDefault,
    asset_json: true,
    bindings: existsSync(join(assetDir, 'default.bindings.json')),
    report_json: existsSync(join(assetDir, 'report.json')),
    lod2_atlas: existsSync(join(assetDir, 'lod2_atlas')),
    lod3_atlas: existsSync(join(assetDir, 'lod3_atlas')),
  };

  let dims_m = null;
  let dims_error = null;
  if (readDims) {
    const dimSrc =
      (existsSync(join(assetDir, 'lod0.glb')) && join(assetDir, 'lod0.glb')) ||
      (hasDefault && join(assetDir, 'default.glb')) ||
      null;
    if (dimSrc) {
      // World-space: cooked KitBash assets place their parts with per-node
      // translations, so the union of raw accessor boxes overstates the size
      // (Brooklyn_Office_Building reads 4.7 m too deep on local bounds).
      const meta = readGlbWorldMeta(dimSrc);
      dims_m = meta.dims_m;
      dims_error = meta.error;
    }
  }

  const findings = assessLodChain(lods);
  const bytes = dirSizeBytes(assetDir);

  return {
    id,
    catalog: 'buildings',
    kit,
    name,
    display_name: assetJson.name || name,
    state: 'in_assets',
    engine_dir: assetDir,
    engine_rel: `Buildings/${kit}/${name}`.replace(/\\/g, '/'),
    lods,
    default_exists: hasDefault,
    files,
    dims_m,
    dims_error,
    bytes,
    mb: Math.round((bytes / (1024 * 1024)) * 10) / 10,
    findings,
    impostor: assetJson.impostor != null,
    sharedTextures: !!assetJson.sharedTextures,
    scene_usage: { instance_count: 0, scene_paths: [], bypasses_lod: false },
  };
}

/**
 * Index cooked folders under TOOL/output for thumb / live-3D paths.
 */
function scanOutput(outputRoot) {
  /** @type {Map<string, {output_dir:string, has_lod2:boolean, lod2_mtime:number|null}>} */
  const map = new Map();
  if (!existsSync(outputRoot)) return map;

  for (const kitEntry of readdirSync(outputRoot, { withFileTypes: true })) {
    if (!kitEntry.isDirectory() || kitEntry.name.startsWith('_')) continue;
    const kitDir = join(outputRoot, kitEntry.name);

    // Flat cooked asset at output/<Asset>/
    if (existsSync(join(kitDir, 'lod0.glb')) || existsSync(join(kitDir, 'asset.json'))) {
      const lod2 = join(kitDir, 'lod2.glb');
      map.set(kitEntry.name, {
        output_dir: kitDir,
        output_key: kitEntry.name,
        has_lod2: existsSync(lod2),
        lod2_mtime: existsSync(lod2) ? statSync(lod2).mtimeMs : null,
      });
      continue;
    }

    for (const child of readdirSync(kitDir, { withFileTypes: true })) {
      if (!child.isDirectory() || child.name.startsWith('_')) continue;
      const assetDir = join(kitDir, child.name);
      if (!existsSync(join(assetDir, 'lod0.glb')) && !existsSync(join(assetDir, 'asset.json'))) {
        continue;
      }
      const id = `${kitEntry.name}/${child.name}`;
      const lod2 = join(assetDir, 'lod2.glb');
      map.set(id, {
        output_dir: assetDir,
        output_key: id,
        has_lod2: existsSync(lod2),
        lod2_mtime: existsSync(lod2) ? statSync(lod2).mtimeMs : null,
      });
      // Also index by bare name for fuzzy match
      if (!map.has(child.name)) {
        map.set(child.name, map.get(id));
      }
    }
  }
  return map;
}

/**
 * Parse scene.json for building instance counts.
 */
function scanSceneUsage(assetsRoot) {
  const scenePath = join(assetsRoot, 'scene.json');
  /** @type {Map<string, {count:number, paths:string[], bypasses:boolean}>} */
  const usage = new Map();
  if (!existsSync(scenePath)) return usage;

  const scene = safeReadJson(scenePath);
  if (!scene?.objects) return usage;

  for (const obj of scene.objects) {
    const modelPath = obj.modelPath || obj.model || '';
    if (!modelPath || typeof modelPath !== 'string') continue;
    const norm = modelPath.replace(/\\/g, '/');
    if (!norm.startsWith('Buildings/')) continue;

    const parts = norm.split('/');
    // Buildings/<Kit>/<Asset>/file.glb  OR Buildings/<folder>/file.glb
    let id = null;
    let bypasses = false;
    if (parts.length >= 4) {
      id = `${parts[1]}/${parts[2]}`;
      const file = parts[parts.length - 1].toLowerCase();
      bypasses = /^lod\d+\.glb$/.test(file);
    } else if (parts.length === 3) {
      // Buildings/<Something>/file.glb — treat as raw
      id = `${parts[1]}/${parts[2].replace(/\.glb$/i, '')}`;
    } else {
      continue;
    }

    const cur = usage.get(id) || { count: 0, paths: [], bypasses: false };
    cur.count += 1;
    if (cur.paths.length < 8) cur.paths.push(norm);
    if (bypasses) cur.bypasses = true;
    usage.set(id, cur);
  }
  return usage;
}

/**
 * E6: walk Kitbash Assets for source-only GLBs.
 */
function scanKitbashSource(kitbashRoot) {
  const sources = [];
  if (!existsSync(kitbashRoot)) return sources;

  for (const kitEntry of readdirSync(kitbashRoot, { withFileTypes: true })) {
    if (!kitEntry.isDirectory() || kitEntry.name.startsWith('_') || kitEntry.name.startsWith('.')) {
      continue;
    }
    const kitDir = join(kitbashRoot, kitEntry.name);
    for (const file of readdirSync(kitDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.toLowerCase().endsWith('.glb')) continue;
      const name = file.name.replace(/\.glb$/i, '');
      sources.push({
        id: `${kitEntry.name}/${name}`,
        kit: kitEntry.name,
        name,
        source_path: join(kitDir, file.name),
        source_rel: `${kitEntry.name}/${file.name}`,
        file_bytes: statSync(join(kitDir, file.name)).size,
        normalized: normalizeName(name),
      });
    }
  }
  return sources;
}

function mergeSourceMatches(assets, sources) {
  const byNorm = new Map();
  for (const a of assets) {
    const key = normalizeName(a.name);
    if (!byNorm.has(key)) byNorm.set(key, []);
    byNorm.get(key).push(a);
  }

  const matchedSourceIds = new Set();
  for (const a of assets) {
    a.match_confidence = 'none';
    a.source_rel = null;
    const key = normalizeName(a.name);
    const hits = sources.filter((s) => s.normalized === key && s.kit === a.kit);
    const loose = hits.length ? hits : sources.filter((s) => s.normalized === key);
    if (loose.length === 1) {
      a.match_confidence = 'name_only';
      a.source_rel = loose[0].source_rel;
      matchedSourceIds.add(loose[0].id);
    } else if (loose.length > 1) {
      a.match_confidence = 'name_ambiguous';
      a.source_rel = loose[0].source_rel;
      for (const h of loose) matchedSourceIds.add(h.id);
    }
  }

  const sourceOnly = [];
  for (const s of sources) {
    if (matchedSourceIds.has(s.id)) continue;
    // Exact id match already in assets?
    if (assets.some((a) => a.id === s.id)) continue;
    sourceOnly.push({
      id: s.id,
      catalog: 'buildings',
      kit: s.kit,
      name: s.name,
      display_name: s.name,
      state: 'source_only',
      source_rel: s.source_rel,
      match_confidence: 'none',
      file_bytes: s.file_bytes,
      mb: Math.round((s.file_bytes / (1024 * 1024)) * 10) / 10,
      lods: [],
      findings: [],
      scene_usage: { instance_count: 0, scene_paths: [], bypasses_lod: false },
      dims_m: null,
    });
  }
  return sourceOnly;
}

export function buildIndex(options = {}) {
  const readDims = options.readDims !== false;
  const withSource = options.withSource === true;
  const assetsRoot = resolveAssetsRoot();
  const outputRoot = resolveOutputRoot();
  const kitbashRoot = resolveKitbashRoot();
  const scanTs = new Date().toISOString();
  const prevFirstSeen = loadPreviousFirstSeen();

  const { cooked, raw } = scanEngineBuildings(assetsRoot, { readDims });
  const outputMap = scanOutput(outputRoot);
  const usage = scanSceneUsage(assetsRoot);

  for (const a of cooked) {
    // Attach output paths
    const out =
      outputMap.get(a.id) ||
      outputMap.get(a.name) ||
      null;
    a.output_dir = out?.output_dir || null;
    a.output_key = out?.output_key || null;
    a.has_lod2 = !!out?.has_lod2;
    a.lod2_mtime = out?.lod2_mtime ?? null;

    // Scene usage
    const u = usage.get(a.id);
    if (u) {
      a.scene_usage = {
        instance_count: u.count,
        scene_paths: u.paths,
        bypasses_lod: u.bypasses,
      };
      if (u.bypasses) {
        a.findings.push({
          code: 'obchazi_lod',
          severity: 'warn',
          message: 'scéna odkazuje přímo na lodN.glb (obchází LOD řetězec)',
        });
      }
      if (u.count > 0) a.state = 'used_in_scene';
    }

    a.first_seen = prevFirstSeen.get(a.id) || scanTs;
    a.is_new = !prevFirstSeen.has(a.id);
  }

  for (const r of raw) {
    const u = usage.get(r.id);
    if (u) {
      r.scene_usage = {
        instance_count: u.count,
        scene_paths: u.paths,
        bypasses_lod: u.bypasses,
      };
    } else {
      r.scene_usage = { instance_count: 0, scene_paths: [], bypasses_lod: false };
    }
    r.lods = [];
    r.findings = [];
    r.first_seen = prevFirstSeen.get(r.id) || scanTs;
    r.is_new = !prevFirstSeen.has(r.id);
    r.display_name = r.name;
    r.mb = Math.round((r.file_bytes / (1024 * 1024)) * 10) / 10;
  }

  let assets = [...cooked, ...raw];

  let sourceOnly = [];
  if (withSource) {
    const sources = scanKitbashSource(kitbashRoot);
    sourceOnly = mergeSourceMatches(cooked, sources);
    for (const s of sourceOnly) {
      s.first_seen = prevFirstSeen.get(s.id) || scanTs;
      s.is_new = !prevFirstSeen.has(s.id);
    }
    assets = [...assets, ...sourceOnly];
  }

  const percentileStats = attachPercentiles(cooked);

  const buildingsSummary = {
    cooked: cooked.length,
    raw: raw.length,
    source_only: sourceOnly.length,
    used_in_scene: cooked.filter((a) => a.state === 'used_in_scene').length,
    unused: cooked.filter((a) => a.state === 'in_assets').length,
    new_count: assets.filter((a) => a.is_new).length,
    findings: {
      inverze: countFinding(cooked, 'inverze'),
      zbytecny_lod: countFinding(cooked, 'zbytecny_lod'),
      neuplny_retez: countFinding(cooked, 'neuplny_retez'),
      obchazi_lod: countFinding(cooked, 'obchazi_lod'),
    },
    lod2_percentiles: percentileStats,
  };

  const vehicleScan = scanVehicles(assetsRoot, {
    readDims,
    prevFirstSeen,
    scanTs,
  });

  return {
    schemaVersion: 2,
    generatedBy: 'src/library-index.js',
    scan_ts: scanTs,
    roots: {
      assets: assetsRoot,
      output: outputRoot,
      kitbash: withSource ? kitbashRoot : null,
    },
    catalogs: {
      buildings: { summary: buildingsSummary, assets },
      vehicles: vehicleScan,
    },
    // Back-compat for scripts still reading flat assets (buildings only)
    summary: buildingsSummary,
    assets,
  };
}

function countFinding(assets, code) {
  return assets.filter((a) => (a.findings || []).some((f) => f.code === code)).length;
}

export function writeIndex(index, outPath = INDEX_PATH) {
  writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  return outPath;
}

function printSummary(index) {
  const buildings = index.catalogs?.buildings?.summary || index.summary;
  const vehicles = index.catalogs?.vehicles?.summary;
  console.log('============================================');
  console.log('  Asset Library — scan');
  console.log('============================================');
  console.log(`Assets:  ${index.roots.assets}`);
  console.log(`Output:  ${index.roots.output}`);
  if (index.roots.kitbash) console.log(`Kitbash: ${index.roots.kitbash}`);
  console.log(`Scan:    ${index.scan_ts}`);
  console.log('');
  console.log(
    `Budovy — cooked: ${buildings.cooked}  |  raw: ${buildings.raw}  |  source_only: ${buildings.source_only}  |  nové: ${buildings.new_count}`,
  );
  console.log(`  ve scéně: ${buildings.used_in_scene}  |  nepoužité: ${buildings.unused}`);
  console.log('');
  console.log('Nálezy (budovy):');
  console.log(`  inverze:       ${buildings.findings.inverze}`);
  console.log(`  zbytečný LOD:  ${buildings.findings.zbytecny_lod}`);
  console.log(`  neúplný řetěz: ${buildings.findings.neuplny_retez}`);
  console.log(`  obchází LOD:   ${buildings.findings.obchazi_lod}`);
  const p = buildings.lod2_percentiles;
  if (p?.count) {
    console.log('');
    console.log(
      `LOD2 tris: min ${p.min?.toLocaleString()} | p50 ${p.p50?.toLocaleString()} | p90 ${p.p90?.toLocaleString()} | max ${p.max?.toLocaleString()}`,
    );
  }

  if (vehicles) {
    console.log('');
    console.log(
      `Auta: ${vehicles.total}  |  nekompletní: ${vehicles.findings.nekompletni}  |  duplicity: ${vehicles.findings.duplicita_jmena}`,
    );
    console.log(
      `  vehicle.json: ${vehicles.with_vehicle_json}  |  raw: ${vehicles.vehicle_raw}  |  loose: ${vehicles.vehicle_loose}`,
    );
    console.log(`  ve scéně: ${vehicles.used_in_scene}  |  nepoužité: ${vehicles.unused}`);
    const vp = vehicles.body_tris_percentiles;
    if (vp?.count) {
      console.log(
        `  body tris: min ${vp.min?.toLocaleString()} | p50 ${vp.p50?.toLocaleString()} | p90 ${vp.p90?.toLocaleString()} | max ${vp.max?.toLocaleString()}`,
      );
    }
  }

  const buildingAssets = index.catalogs?.buildings?.assets || index.assets || [];
  const inversions = buildingAssets.filter((a) =>
    (a.findings || []).some((f) => f.code === 'inverze'),
  );
  if (inversions.length) {
    console.log('');
    console.log('Inverze:');
    for (const a of inversions) {
      const f = a.findings.find((x) => x.code === 'inverze');
      console.log(`  ${a.id} — ${f.message}`);
    }
  }
  console.log('');
}

const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const args = process.argv.slice(2);
  const readDims = !args.includes('--no-dims');
  const withSource = args.includes('--with-source');
  const t0 = Date.now();
  const index = buildIndex({ readDims, withSource });
  const out = writeIndex(index);
  printSummary(index);
  console.log(`Zapsáno: ${out}  (${Date.now() - t0} ms)`);
}
