import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import { listTextureSlots } from '@gltf-transform/functions';
import { resolveToktx } from './convert.js';

/**
 * Compress document textures to KTX2 via toktx.
 * ETC1S for baseColor, UASTC for normal / ORM / metallicRoughness.
 * @param {import('@gltf-transform/core').Document} document
 * @param {{ toktx?: string|null }} [opts]
 */
export async function compressTexturesKtx2(document, opts = {}) {
  const toktx = resolveToktx(opts.toktx);
  if (!toktx) {
    throw new Error(
      'toktx not found. Install KTX-Software or set tools.config.json "toktx".',
    );
  }

  document.createExtension(KHRTextureBasisu).setRequired(true);

  const work = mkdtempSync(join(tmpdir(), 'hp-ktx2-'));
  const textures = document.getRoot().listTextures();
  let converted = 0;

  try {
    for (let i = 0; i < textures.length; i++) {
      const texture = textures[i];
      const image = texture.getImage();
      const mime = texture.getMimeType() || '';
      if (!image || image.byteLength === 0) continue;
      if (mime.includes('ktx')) continue;

      const slots = listTextureSlots(texture);
      const isNormal = slots.some((s) => /normal/i.test(s));
      const isData = slots.some((s) =>
        /metallic|roughness|occlusion|orm/i.test(s),
      );
      const useUastc = isNormal || isData;

      const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
      const srcPath = join(work, `tex_${i}.${ext}`);
      const dstPath = join(work, `tex_${i}.ktx2`);
      writeFileSync(srcPath, image);

      const args = useUastc
        ? [
            '--t2',
            '--encode',
            'uastc',
            '--uastc_quality',
            '2',
            '--genmipmap',
            '--assign_oetf',
            'linear',
            dstPath,
            srcPath,
          ]
        : [
            '--t2',
            '--encode',
            'etc1s',
            '--clevel',
            '2',
            '--qlevel',
            '255',
            '--genmipmap',
            dstPath,
            srcPath,
          ];

      // Normal maps: linear + uastc already; base color uses sRGB default
      if (!useUastc) {
        // strip assign_oetf — etc1s color
      }

      const r = spawnSync(toktx, args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });

      if (r.status !== 0 || !existsSync(dstPath)) {
        console.warn(
          `  ktx2    : skip texture ${i} (${slots.join(',') || texture.getName()}): ${
            (r.stderr || r.stdout || 'toktx failed').split('\n')[0]
          }`,
        );
        continue;
      }

      const ktxBytes = readFileSync(dstPath);
      texture.setImage(ktxBytes).setMimeType('image/ktx2');
      converted += 1;
      console.log(
        `  ktx2    : ${slots.join(',') || texture.getName() || i} → ${
          useUastc ? 'UASTC' : 'ETC1S'
        } (${(ktxBytes.length / 1024).toFixed(0)} KB)`,
      );
    }
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  return { converted, total: textures.length };
}
