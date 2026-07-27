#!/usr/bin/env node
/**
 * Local cook UI — pick Kitbash kits + which LODs to bake.
 *   npm run cook-ui
 *   → http://127.0.0.1:4174
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { listKitFolders } from './convert.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const KITS_ROOT = resolve(ROOT, 'Kitbash Assets');
const UI_DIR = resolve(ROOT, 'cook-ui');
const PORT = Number(process.env.COOK_UI_PORT || 4174);
const HOST = process.env.COOK_UI_HOST || '127.0.0.1';
const MAX_LOG_CHARS = 512 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** @type {Map<string, Job>} */
const jobs = new Map();
/** @type {string|null} */
let activeJobId = null;

/**
 * @typedef {{
 *   id: string,
 *   running: boolean,
 *   exitCode: number|null,
 *   error: string|null,
 *   startedAt: string,
 *   finishedAt: string|null,
 *   command: string,
 *   mode: 'rebake-lod3'|'convert',
 *   kits: string[],
 *   log: string,
 *   child: import('node:child_process').ChildProcess|null,
 * }} Job
 */

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2), MIME['.json']);
}

function safeJoin(base, reqPath) {
  const decoded = decodeURIComponent(reqPath);
  const full = normalize(join(base, decoded));
  const rel = relative(base, full);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) return null;
  return full;
}

function sendFile(res, filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    send(res, 404, 'Not found');
    return;
  }
  const ext = extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(readFileSync(filePath));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function listKitsSafe() {
  if (!existsSync(KITS_ROOT) || !statSync(KITS_ROOT).isDirectory()) {
    return { kitsRoot: KITS_ROOT, kits: [], missing: true };
  }
  const kits = listKitFolders(KITS_ROOT).map((k) => {
    let assetCount = 0;
    try {
      assetCount = readdirSync(k.path).filter((f) =>
        /\.(glb|gltf|fbx|obj)$/i.test(f),
      ).length;
    } catch {
      assetCount = 0;
    }
    return { name: k.name, assetCount };
  });
  return { kitsRoot: KITS_ROOT, kits, missing: false };
}

function appendLog(job, chunk) {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  job.log += text;
  if (job.log.length > MAX_LOG_CHARS) {
    job.log = job.log.slice(-MAX_LOG_CHARS);
  }
}

/**
 * Build spawn config from UI selection.
 * Uses node directly (not npm run) to avoid shell quoting issues with spaces
 * in the "Kitbash Assets" path on Windows.
 * @param {{ kits: string[], lod0?: boolean, lod1?: boolean, lod2Atlas?: boolean, lod3?: boolean, jobs?: number }} body
 * @returns {{ mode: 'rebake-lod3'|'convert', bin: string, args: string[], kits: string[], jobs: number }}
 */
function buildCookCommand(body) {
  const kits = Array.isArray(body.kits)
    ? body.kits.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (!kits.length) {
    throw new Error('Vyber aspoň jeden kit.');
  }

  const lod0 = !!body.lod0;
  const lod1 = !!body.lod1;
  const lod2Atlas = !!body.lod2Atlas;
  const lod3 = !!body.lod3;
  if (!lod0 && !lod1 && !lod2Atlas && !lod3) {
    throw new Error('Zaškrtni aspoň jeden LOD (LOD0/1/2-atlas/LOD3).');
  }

  const jobsN = Math.max(1, Math.min(16, Number(body.jobs) || 4));
  const needConvert = lod0 || lod1 || lod2Atlas;
  const lod3Only = lod3 && !needConvert;
  const outputDir = resolve(ROOT, 'output');

  if (lod3Only) {
    return {
      mode: /** @type {const} */ ('rebake-lod3'),
      bin: process.execPath,
      args: [
        resolve(ROOT, 'scripts', 'rebake-lod3-kits.js'),
        '--force',
        '--jobs',
        String(jobsN),
        ...kits,
      ],
      kits,
      jobs: jobsN,
    };
  }

  // Convert mode: invoke src/cli.js directly with absolute paths so Windows
  // shell quoting never splits "Kitbash Assets" on the space.
  const args = [
    resolve(ROOT, 'src', 'cli.js'),
    '--kits-root',
    KITS_ROOT,           // absolute, passed as argv element — no shell splitting
    '--only',
    kits.join(','),
    '--output',
    outputDir,
    '--no-ktx2',
    '--max-texture',
    '2048',
    '--no-impostor',
    '--shared-textures',
    '--jobs',
    String(jobsN),
  ];
  if (!lod2Atlas) args.push('--no-lod2-atlas');
  if (lod3) {
    args.push('--lod3-silhouette', '--lod3-res', '2048');
  } else {
    args.push('--no-lod3-silhouette');
  }

  return {
    mode: /** @type {const} */ ('convert'),
    bin: process.execPath,
    args,
    kits,
    jobs: jobsN,
  };
}

function startJob(body) {
  if (activeJobId) {
    const cur = jobs.get(activeJobId);
    if (cur?.running) {
      throw new Error(`Už běží job ${activeJobId}. Počkej na dokončení.`);
    }
  }

  const cmd = buildCookCommand(body);
  const id = randomBytes(4).toString('hex');
  /** @type {Job} */
  const job = {
    id,
    running: true,
    exitCode: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    command: [cmd.bin, ...cmd.args].join(' '),
    mode: cmd.mode,
    kits: cmd.kits,
    log: '',
    child: null,
  };

  appendLog(
    job,
    `[cook-ui] mode=${cmd.mode} kits=${cmd.kits.join(', ')} jobs=${cmd.jobs}\n`,
  );
  appendLog(job, `[cook-ui] $ ${job.command}\n\n`);

  // No shell:true — args are passed as array elements so spaces in paths are safe.
  const child = spawn(cmd.bin, cmd.args, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '0' },
    shell: false,
    windowsHide: true,
  });
  job.child = child;
  jobs.set(id, job);
  activeJobId = id;

  child.stdout?.on('data', (d) => appendLog(job, d));
  child.stderr?.on('data', (d) => appendLog(job, d));
  child.on('error', (err) => {
    job.error = err.message;
    appendLog(job, `\n[cook-ui] spawn error: ${err.message}\n`);
  });
  child.on('close', (code) => {
    job.running = false;
    job.exitCode = code ?? 1;
    job.finishedAt = new Date().toISOString();
    job.child = null;
    appendLog(
      job,
      `\n[cook-ui] exit ${job.exitCode}${job.error ? ` — ${job.error}` : ''}\n`,
    );
    if (activeJobId === id) activeJobId = null;
  });

  return job;
}

function jobPublic(job, { includeLog = false, logFrom = 0 } = {}) {
  const out = {
    id: job.id,
    running: job.running,
    exitCode: job.exitCode,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    command: job.command,
    mode: job.mode,
    kits: job.kits,
    logLength: job.log.length,
  };
  if (includeLog) {
    const from = Math.max(0, Number(logFrom) || 0);
    out.log = job.log.slice(from);
    out.logOffset = from;
  }
  return out;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  try {
    if (path === '/api/kits' && method === 'GET') {
      sendJson(res, 200, listKitsSafe());
      return;
    }

    if (path === '/api/cook' && method === 'POST') {
      const body = await readBody(req);
      try {
        const job = startJob(body);
        sendJson(res, 200, { ok: true, job: jobPublic(job) });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (path === '/api/status' && method === 'GET') {
      const id = url.searchParams.get('jobId') || activeJobId;
      if (!id || !jobs.has(id)) {
        sendJson(res, 404, { ok: false, error: 'job not found' });
        return;
      }
      sendJson(res, 200, { ok: true, job: jobPublic(jobs.get(id)) });
      return;
    }

    if (path === '/api/log' && method === 'GET') {
      const id = url.searchParams.get('jobId') || activeJobId;
      if (!id || !jobs.has(id)) {
        sendJson(res, 404, { ok: false, error: 'job not found' });
        return;
      }
      const from = url.searchParams.get('from') || '0';
      sendJson(res, 200, {
        ok: true,
        job: jobPublic(jobs.get(id), { includeLog: true, logFrom: from }),
      });
      return;
    }

    if (path === '/' || path === '/index.html') {
      sendFile(res, join(UI_DIR, 'index.html'));
      return;
    }

    const uiFile = safeJoin(UI_DIR, path.replace(/^\//, ''));
    if (uiFile && existsSync(uiFile) && statSync(uiFile).isFile()) {
      sendFile(res, uiFile);
      return;
    }

    send(res, 404, 'Not found');
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Cook UI → http://${HOST}:${PORT}`);
  console.log(`  kits root: ${KITS_ROOT}`);
  console.log(`  UI files : ${UI_DIR}`);
  if (!existsSync(KITS_ROOT)) {
    console.warn('  (Kitbash Assets/ missing)');
  }
});
