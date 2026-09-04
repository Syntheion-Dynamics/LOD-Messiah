/**
 * LOD-chain health rules that do not need absolute triangle budgets.
 * Findings are internal-logic violations (inversion, useless LOD, incomplete).
 */

/** LOD n+1 must save at least this fraction vs LOD n, else "zbytecny_lod". */
export const USELESS_LOD_THRESHOLD = 0.15;

/**
 * @param {{ level:number, triangles:number|null }[]} lods
 * @returns {{ code:string, severity:'error'|'warn'|'info', message:string, detail?:object }[]}
 */
export function assessLodChain(lods) {
  const findings = [];
  if (!Array.isArray(lods) || lods.length === 0) {
    findings.push({
      code: 'neuplny_retez',
      severity: 'warn',
      message: 'žádné LOD úrovně v asset.json',
    });
    return findings;
  }

  const sorted = [...lods].sort((a, b) => a.level - b.level);
  const levels = new Set(sorted.map((l) => l.level));
  if (sorted.length < 4 || ![0, 1, 2, 3].every((n) => levels.has(n))) {
    findings.push({
      code: 'neuplny_retez',
      severity: 'warn',
      message: `neúplný LOD řetězec (${sorted.map((l) => `lod${l.level}`).join(', ') || 'prázdný'})`,
      detail: { levels: sorted.map((l) => l.level) },
    });
  }

  for (const lod of sorted) {
    if (lod.triangles === 0 && lod.exists !== false) {
      findings.push({
        code: 'neuplny_retez',
        severity: 'warn',
        message: `lod${lod.level} má 0 tris v asset.json`,
        detail: { level: lod.level },
      });
    }
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.triangles == null || b.triangles == null) continue;
    if (a.triangles <= 0) continue;

    if (b.triangles > a.triangles) {
      const pct = ((b.triangles / a.triangles - 1) * 100).toFixed(0);
      findings.push({
        code: 'inverze',
        severity: 'error',
        message: `lod${b.level} je těžší než lod${a.level} (+${pct} %)`,
        detail: {
          from: a.level,
          to: b.level,
          fromTris: a.triangles,
          toTris: b.triangles,
        },
      });
      continue;
    }

    const saving = 1 - b.triangles / a.triangles;
    if (saving < USELESS_LOD_THRESHOLD) {
      findings.push({
        code: 'zbytecny_lod',
        severity: 'warn',
        message: `lod${b.level} šetří jen ${(saving * 100).toFixed(0)} % oproti lod${a.level}`,
        detail: {
          from: a.level,
          to: b.level,
          fromTris: a.triangles,
          toTris: b.triangles,
          saving,
        },
      });
    }
  }

  return findings;
}

/**
 * Percentile rank of value within sorted ascending list (0–100).
 * @param {number} value
 * @param {number[]} sortedAsc
 */
export function percentileRank(value, sortedAsc) {
  if (!sortedAsc.length || value == null || Number.isNaN(value)) return null;
  let below = 0;
  for (const v of sortedAsc) {
    if (v < value) below += 1;
    else break;
  }
  return Math.round((below / sortedAsc.length) * 100);
}

/**
 * @param {number[]} values
 * @param {number} p 0–100
 */
export function percentileValue(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Attach lod2 percentile ranks across the library.
 * @param {Array<{ lods?: {level:number, triangles:number|null}[] }>} assets
 */
export function attachPercentiles(assets) {
  const lod2Values = [];
  for (const a of assets) {
    const lod2 = (a.lods || []).find((l) => l.level === 2);
    if (lod2?.triangles != null) lod2Values.push(lod2.triangles);
  }
  const sorted = [...lod2Values].sort((a, b) => a - b);
  const stats = {
    count: sorted.length,
    p50: percentileValue(sorted, 50),
    p90: percentileValue(sorted, 90),
    p95: percentileValue(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    min: sorted.length ? sorted[0] : null,
  };

  for (const a of assets) {
    const lod2 = (a.lods || []).find((l) => l.level === 2);
    a.lod2_percentile =
      lod2?.triangles != null ? percentileRank(lod2.triangles, sorted) : null;
  }

  return stats;
}
