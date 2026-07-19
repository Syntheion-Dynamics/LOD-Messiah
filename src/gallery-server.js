#!/usr/bin/env node
/**
 * Lightweight local gallery for cooked assets (list + impostor preview).
 *   npm run gallery
 *   → http://127.0.0.1:4173
 */
import {
  createServer,
} from 'node:http';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUTPUT = resolve(ROOT, 'output');
const GALLERY_DIR = resolve(ROOT, 'gallery');
const PORT = Number(process.env.GALLERY_PORT || 4173);
const HOST = process.env.GALLERY_HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function listAssets() {
  if (!existsSync(OUTPUT)) return [];

  const entries = readdirSync(OUTPUT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  return entries.map((name) => {
    const dir = join(OUTPUT, name);
    const reportPath = join(dir, 'report.json');
    let report = null;
    if (existsSync(reportPath)) {
      try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'));
      } catch {
        report = null;
      }
    }

    const hasAtlas = existsSync(join(dir, 'impostor_atlas.png'));
    const hasPreview = existsSync(join(dir, 'preview.html'));
    const hasImpostorGlb = existsSync(join(dir, 'impostor.glb'));
    const hasLod0 = existsSync(join(dir, 'lod0.glb'));

    const lods = Array.isArray(report?.lods)
      ? report.lods
          .filter((l) => !l.impostor)
          .map((l) => ({
            label: l.label,
            tris: l.stats?.triangles ?? null,
            mb: l.stats?.fileMB ?? null,
            health: l.health?.msg ?? null,
          }))
      : [];

    const impostorLod = Array.isArray(report?.lods)
      ? report.lods.find((l) => l.impostor)
      : null;

    return {
      name,
      hasAtlas,
      hasPreview,
      hasImpostorGlb,
      hasLod0,
      materialsBefore: report?.materialsBefore ?? null,
      materialsAfter: report?.materialsAfter ?? null,
      texturesBefore: report?.texturesBefore ?? null,
      texturesAfter: report?.texturesAfter ?? null,
      beforeTris: report?.before?.triangles ?? report?.beforeRaw?.triangles ?? null,
      atlasUsed: report?.options?.atlasUsed ?? false,
      ktx2: report?.options?.ktx2 ?? null,
      generatedAt: report?.generatedAt ?? null,
      lods,
      impostor: hasAtlas
        ? {
            atlasUrl: `/files/${encodeURIComponent(name)}/impostor_atlas.png`,
            previewUrl: hasPreview
              ? `/files/${encodeURIComponent(name)}/preview.html`
              : null,
            mb: impostorLod?.stats?.fileMB ?? report?.impostor?.stats?.fileMB ?? null,
            mode: report?.impostor?.mode || report?.options?.impostorMode || 'octahedral',
          }
        : null,
    };
  });
}

function safeJoin(base, reqPath) {
  const decoded = decodeURIComponent(reqPath);
  const full = normalize(join(base, decoded));
  const rel = relative(base, full);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) return null;
  return full;
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(body);
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
    'Cache-Control': ext === '.html' || ext === '.json' ? 'no-store' : 'public, max-age=60',
  });
  res.end(readFileSync(filePath));
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (path === '/api/assets') {
    send(res, 200, JSON.stringify({ output: OUTPUT, assets: listAssets() }, null, 2), MIME['.json']);
    return;
  }

  if (path.startsWith('/files/')) {
    const rest = path.slice('/files/'.length);
    const filePath = safeJoin(OUTPUT, rest);
    if (!filePath) {
      send(res, 403, 'Forbidden');
      return;
    }
    sendFile(res, filePath);
    return;
  }

  if (path === '/' || path === '/index.html') {
    sendFile(res, join(GALLERY_DIR, 'index.html'));
    return;
  }

  if (path.startsWith('/gallery/')) {
    const filePath = safeJoin(GALLERY_DIR, path.slice('/gallery/'.length));
    if (!filePath) {
      send(res, 403, 'Forbidden');
      return;
    }
    sendFile(res, filePath);
    return;
  }

  // static from gallery root (styles etc.)
  const galleryFile = safeJoin(GALLERY_DIR, path.replace(/^\//, ''));
  if (galleryFile && existsSync(galleryFile) && statSync(galleryFile).isFile()) {
    sendFile(res, galleryFile);
    return;
  }

  send(res, 404, 'Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Cook gallery → http://${HOST}:${PORT}`);
  console.log(`  scanning: ${OUTPUT}`);
  if (!existsSync(OUTPUT)) {
    console.warn('  (output/ missing — run convert first)');
  }
});
