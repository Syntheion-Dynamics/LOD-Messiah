import { spawn } from 'node:child_process';

/**
 * Non-blocking child process (allows parallel Blender / tool jobs).
 * @param {string} bin
 * @param {string[]} args
 * @param {{ maxBuffer?: number }} [opts]
 * @returns {Promise<{ status: number|null, stdout: string, stderr: string }>}
 */
export function spawnAsync(bin, args, opts = {}) {
  const maxBuffer = opts.maxBuffer ?? 256 * 1024 * 1024;
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (target, chunk) => {
      if (truncated) return target;
      const next = target + chunk;
      if (next.length > maxBuffer) {
        truncated = true;
        return `${next.slice(0, maxBuffer)}\n…[truncated]`;
      }
      return next;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (err) => {
      stderr = append(stderr, `\n${err.message}`);
      resolvePromise({ status: 1, stdout, stderr });
    });
    child.on('close', (status) => {
      resolvePromise({ status, stdout, stderr });
    });
  });
}
