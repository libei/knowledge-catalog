// Shared probe for the sqlglot-backed tests: which Python to use, and whether
// sqlglot is actually importable. sqlglot is an optional dev dependency, so the
// transformation/verification tests gate on `sqlglotAvailable()` and skip when it
// is absent (the pipeline degrades to verbatim + warning in that case).

import { spawnSync } from 'node:child_process';

// The interpreter the transpiler uses, honoring the same override as
// `sqlglotTranspiler` (src/libts/semantic/transpile.ts).
export function pythonBin(): string {
  return process.env.KCMD_PYTHON || 'python3';
}

// True only if `import sqlglot` succeeds under `pythonBin()`.
export function sqlglotAvailable(): boolean {
  try {
    const r = spawnSync(pythonBin(), ['-c', 'import sqlglot'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}
