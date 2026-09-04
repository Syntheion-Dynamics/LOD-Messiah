/**
 * Vehicle catalog scanner — Assets/Cars via *.vehicle.json.
 * Read-only toward engine repo.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readGlbWorldMeta } from './lib/glb-meta.js';
import { normalizeName } from './library-index.js';
import {
  percentileRank,
  percentileValue,
} from './library-health.js';

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
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

function listGlbs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.glb'))
    .map((e) => e.name);
}

function findVehicleJson(dir) {
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.vehicle.json'))
    .map((e) => join(dir, e.name));
  return hits[0] || null;
}

function readGlbStatsFromFile(fullPath) {
  if (!fullPath || !existsSync(fullPath)) {
    return {
      exists: false,
      tris: null,
      dims_m: null,
      dims_error: fullPath ? 'missing file' : null,
      mtime: null,
    };
  }
  // World-space: about a third of the cars store their vertices on the X axis
  // and stand them up with a root-node rotation, so accessor bounds report a
  // car that is 6 m tall or has length and width swapped.
  const meta = readGlbWorldMeta(fullPath);
  return {
    exists: true,
    tris: meta.triangleEstimate,
    dims_m: meta.dims_m,
    dims_error: meta.error,
    mtime: statSync(fullPath).mtimeMs,
  };
}

/**
 * Parse scene.json for vehicle instance counts.
 * @returns {Map<string, {count:number, paths:string[], loose:boolean}>}
 */
export function scanVehicleSceneUsage(assetsRoot) {
  const scenePath = join(assetsRoot, 'scene.json');
  const usage = new Map();
  if (!existsSync(scenePath)) return usage;

  const scene = safeReadJson(scenePath);
  if (!scene?.objects) return usage;

  for (const obj of scene.objects) {
    const modelPath = obj.modelPath || obj.model || '';
    if (!modelPath || typeof modelPath !== 'string') continue;
    const norm = modelPath.replace(/\\/g, '/');
    if (!norm.startsWith('Cars/')) continue;

    const parts = norm.split('/');
    let id = null;
    let loose = false;

    if (parts.length === 2 && parts[1].toLowerCase().endsWith('.glb')) {
      id = `Cars/${parts[1].replace(/\.glb$/i, '')}`;
      loose = true;
    } else if (parts.length >= 3) {
      id = `Cars/${parts[1]}`;
    } else {
      continue;
    }

    const cur = usage.get(id) || { count: 0, paths: [], loose: false };
    cur.count += 1;
    if (cur.paths.length < 8) cur.paths.push(norm);
    if (loose) cur.loose = true;
    usage.set(id, cur);
  }
  return usage;
}

function assessVehicleFindings(asset, glbFiles, hasVehicleJson) {
  const findings = [];

  if (!hasVehicleJson) {
    findings.push({
      code: 'nekompletni',
      severity: 'warn',
      message: 'chybí *.vehicle.json',
    });
  }

  if (hasVehicleJson && asset.body_file && !asset.body_exists) {
    findings.push({
      code: 'nekompletni',
      severity: 'error',
      message: `body soubor z JSON neexistuje: ${asset.body_file}`,
    });
  }

  if (hasVehicleJson && asset.wheel_file && !asset.wheel_exists) {
    findings.push({
      code: 'chybi_kolo',
      severity: 'warn',
      message: `wheel v JSON ale soubor chybí: ${asset.wheel_file}`,
    });
  }

  if (hasVehicleJson && glbFiles.length) {
    const jsonBodies = [asset.body_file, asset.wheel_file].filter(Boolean);
    const onDisk = new Set(glbFiles);
    const jsonMissingOnDisk = jsonBodies.filter((f) => !onDisk.has(f));
    const extraOnDisk = glbFiles.filter(
      (f) => !jsonBodies.includes(f) && !f.toLowerCase().includes('wheel'),
    );
    if (jsonMissingOnDisk.length || (extraOnDisk.length && !asset.body_exists)) {
      findings.push({
        code: 'soubor_nev_vehicle_json',
        severity: 'warn',
        message: 'GLB na disku neodpovídá vehicle.json',
        detail: { jsonMissingOnDisk, extraOnDisk },
      });
    }
  }

  // Mirrors the suspicious_axis rule in vehicle-inventory.js: a body taller
  // than it is long is either mis-rotated or carrying stray geometry. Only
  // meaningful on world bounds — on accessor bounds this fired on every car
  // whose root node holds the rotation, which is a third of them.
  if (asset.dims_m) {
    const { x, y, z } = asset.dims_m;
    if (y > Math.max(x, z)) {
      findings.push({
        code: 'podezrela_osa',
        severity: 'warn',
        message: `body je vyšší (${y.toFixed(2)} m) než delší — zkontroluj orientaci`,
        detail: { dims_m: asset.dims_m },
      });
    }
  }

  return findings;
}

/**
 * @param {string} assetsRoot
 * @param {{ readDims?: boolean, prevFirstSeen?: Map<string,string> }} options
 */
export function scanVehicles(assetsRoot, options = {}) {
  const readDims = options.readDims !== false;
  const prevFirstSeen = options.prevFirstSeen || new Map();
  const scanTs = options.scanTs || new Date().toISOString();
  const carsRoot = join(assetsRoot, 'Cars');
  const assets = [];

  if (!existsSync(carsRoot)) {
    return { assets: [], summary: emptyVehicleSummary() };
  }

  const usage = scanVehicleSceneUsage(assetsRoot);
  const normToIds = new Map();

  // Folders
  for (const entry of readdirSync(carsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) {
      continue;
    }
    const folder = entry.name;
    const id = `Cars/${folder}`;
    const assetDir = join(carsRoot, folder);
    const vehicleJsonPath = findVehicleJson(assetDir);
    const glbFiles = listGlbs(assetDir);
    const hasVehicleJson = !!vehicleJsonPath;

    let vehicleJson = null;
    if (vehicleJsonPath) {
      vehicleJson = safeReadJson(vehicleJsonPath);
    }

    const bodyFile = vehicleJson?.body || null;
    const wheelFile = vehicleJson?.wheel || null;
    const bodyPath = bodyFile ? join(assetDir, bodyFile) : null;
    const wheelPath = wheelFile ? join(assetDir, wheelFile) : null;

    const bodyStats =
      readDims && bodyPath
        ? readGlbStatsFromFile(bodyPath)
        : {
            exists: !!(bodyPath && existsSync(bodyPath)),
            tris: null,
            dims_m: null,
            dims_error: null,
            mtime:
              bodyPath && existsSync(bodyPath) ? statSync(bodyPath).mtimeMs : null,
          };
    const wheelStats =
      readDims && wheelPath
        ? readGlbStatsFromFile(wheelPath)
        : {
            exists: !!(wheelPath && existsSync(wheelPath)),
            tris: null,
            dims_m: null,
            dims_error: null,
            mtime:
              wheelPath && existsSync(wheelPath) ? statSync(wheelPath).mtimeMs : null,
          };

    if (!readDims) {
      bodyStats.exists = !!(bodyPath && existsSync(bodyPath));
      wheelStats.exists = !!(wheelPath && existsSync(wheelPath));
      if (bodyStats.exists) bodyStats.mtime = statSync(bodyPath).mtimeMs;
      if (wheelStats.exists) wheelStats.mtime = statSync(wheelPath).mtimeMs;
    }

    const bytes = dirSizeBytes(assetDir);
    const asset = {
      id,
      catalog: 'vehicles',
      kit: 'Cars',
      name: folder,
      display_name: vehicleJson?.displayName || vehicleJson?.name || folder,
      vehicle_class: vehicleJson?.class || null,
      mass: typeof vehicleJson?.mass === 'number' ? vehicleJson.mass : null,
      state: hasVehicleJson ? 'vehicle' : 'vehicle_raw',
      engine_dir: assetDir,
      engine_rel: `Cars/${folder}`.replace(/\\/g, '/'),
      vehicle_json: vehicleJsonPath ? relative(assetsRoot, vehicleJsonPath).replace(/\\/g, '/') : null,
      body_file: bodyFile,
      wheel_file: wheelFile,
      body_exists: bodyStats.exists,
      wheel_exists: wheelStats.exists,
      body_tris: bodyStats.tris,
      wheel_tris: wheelStats.tris,
      body_mtime: bodyStats.mtime,
      dims_m: bodyStats.dims_m,
      dims_error: bodyStats.dims_error,
      glb_candidates: hasVehicleJson ? [] : glbFiles,
      bytes,
      mb: Math.round((bytes / (1024 * 1024)) * 10) / 10,
      findings: [],
      scene_usage: { instance_count: 0, scene_paths: [], bypasses_vehicle: false },
      first_seen: prevFirstSeen.get(id) || scanTs,
      is_new: !prevFirstSeen.has(id),
    };

    asset.findings = assessVehicleFindings(asset, glbFiles, hasVehicleJson);

    const u = usage.get(id);
    if (u) {
      asset.scene_usage = {
        instance_count: u.count,
        scene_paths: u.paths,
        bypasses_vehicle: u.loose,
      };
      if (u.count > 0) asset.state = hasVehicleJson ? 'used_in_scene' : 'vehicle_raw_used';
      if (u.loose && hasVehicleJson) {
        asset.findings.push({
          code: 'obchazi_vehicle',
          severity: 'warn',
          message: 'scéna odkazuje na loose .glb místo složky s vehicle.json',
        });
      }
    }

    const normKey = normalizeName(folder);
    if (!normToIds.has(normKey)) normToIds.set(normKey, []);
    normToIds.get(normKey).push(id);

    assets.push(asset);
  }

  // Loose GLB directly under Cars/
  for (const entry of readdirSync(carsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.glb')) continue;
    const name = entry.name.replace(/\.glb$/i, '');
    const id = `Cars/${name}`;
    if (assets.some((a) => a.id === id)) continue;

    const full = join(carsRoot, entry.name);
    const meta = readDims ? readGlbWorldMeta(full) : { triangleEstimate: null, dims_m: null, error: null };
    const u = usage.get(id);

    assets.push({
      id,
      catalog: 'vehicles',
      kit: 'Cars',
      name,
      display_name: name,
      vehicle_class: null,
      mass: null,
      state: 'vehicle_loose',
      engine_path: relative(assetsRoot, full).replace(/\\/g, '/'),
      engine_rel: `Cars/${entry.name}`.replace(/\\/g, '/'),
      vehicle_json: null,
      body_file: entry.name,
      wheel_file: null,
      body_exists: true,
      wheel_exists: false,
      body_tris: meta.triangleEstimate,
      wheel_tris: null,
      body_mtime: statSync(full).mtimeMs,
      dims_m: meta.dims_m,
      dims_error: meta.error,
      glb_candidates: [entry.name],
      bytes: statSync(full).size,
      mb: Math.round((statSync(full).size / (1024 * 1024)) * 10) / 10,
      findings: [
        {
          code: 'nekompletni',
          severity: 'warn',
          message: 'loose GLB bez vehicle.json složky',
        },
      ],
      scene_usage: u
        ? { instance_count: u.count, scene_paths: u.paths, bypasses_vehicle: true }
        : { instance_count: 0, scene_paths: [], bypasses_vehicle: false },
      first_seen: prevFirstSeen.get(id) || scanTs,
      is_new: !prevFirstSeen.has(id),
    });
  }

  // Duplicate name findings
  for (const [, ids] of normToIds) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      const a = assets.find((x) => x.id === id);
      if (!a) continue;
      a.findings.push({
        code: 'duplicita_jmena',
        severity: 'warn',
        message: `normalizované jméno koliduje: ${ids.join(', ')}`,
        detail: { ids },
      });
    }
  }

  const percentileStats = attachBodyPercentiles(assets);

  const summary = {
    total: assets.length,
    with_vehicle_json: assets.filter((a) => a.vehicle_json).length,
    vehicle_raw: assets.filter((a) => a.state === 'vehicle_raw' || a.state === 'vehicle_raw_used').length,
    vehicle_loose: assets.filter((a) => a.state === 'vehicle_loose').length,
    used_in_scene: assets.filter((a) => (a.scene_usage?.instance_count || 0) > 0).length,
    unused: assets.filter((a) => (a.scene_usage?.instance_count || 0) === 0).length,
    new_count: assets.filter((a) => a.is_new).length,
    findings: {
      nekompletni: countFinding(assets, 'nekompletni'),
      chybi_kolo: countFinding(assets, 'chybi_kolo'),
      duplicita_jmena: countFinding(assets, 'duplicita_jmena'),
      soubor_nev_vehicle_json: countFinding(assets, 'soubor_nev_vehicle_json'),
      obchazi_vehicle: countFinding(assets, 'obchazi_vehicle'),
    },
    body_tris_percentiles: percentileStats,
  };

  return { assets, summary };
}

function countFinding(assets, code) {
  return assets.filter((a) => (a.findings || []).some((f) => f.code === code)).length;
}

function emptyVehicleSummary() {
  return {
    total: 0,
    with_vehicle_json: 0,
    vehicle_raw: 0,
    vehicle_loose: 0,
    used_in_scene: 0,
    unused: 0,
    new_count: 0,
    findings: {
      nekompletni: 0,
      chybi_kolo: 0,
      duplicita_jmena: 0,
      soubor_nev_vehicle_json: 0,
      obchazi_vehicle: 0,
    },
    body_tris_percentiles: { count: 0 },
  };
}

function attachBodyPercentiles(assets) {
  const values = [];
  for (const a of assets) {
    if (a.body_tris != null) values.push(a.body_tris);
  }
  const sorted = [...values].sort((x, y) => x - y);
  const stats = {
    count: sorted.length,
    p50: percentileValue(sorted, 50),
    p90: percentileValue(sorted, 90),
    p95: percentileValue(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    min: sorted.length ? sorted[0] : null,
  };
  for (const a of assets) {
    a.body_tris_percentile =
      a.body_tris != null ? percentileRank(a.body_tris, sorted) : null;
  }
  return stats;
}
