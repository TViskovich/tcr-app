#!/usr/bin/env node
// Server-key usage guard (Supabase secret API keys / legacy service-role JWT).
//
// Fails when:
//   * an Edge Function reads SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SECRET_KEYS
//     or the CACHECASE_LOCAL_* test overrides anywhere except
//     supabase/functions/_shared/service-key.ts (the one resolver);
//   * code sends a server key as `Authorization: Bearer …` (Storage rejects a
//     secret key there, and keys must never be function-to-function
//     credentials — use storageAuthHeaders());
//   * a function calls account-export over HTTP (the export sweep runs
//     in-process in account-maintenance);
//   * app code (app/, components/, hooks/, lib/) mentions a server key.
// Comments are ignored. Run:  npm run check:server-keys
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  if (name === 'node_modules' || name.startsWith('.')) return [];
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js)$/.test(name) ? [p] : [];
});
// Code only: strip // line comments and /* */ blocks.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'));

const problems = [];
const RESOLVER = 'supabase/functions/_shared/service-key.ts';
for (const file of walk(join(root, 'supabase/functions'))) {
  const rel = relative(root, file);
  if (rel.endsWith('.test.ts')) continue;
  code(readFileSync(file, 'utf8')).forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    if (rel !== RESOLVER && /SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEYS|CACHECASE_LOCAL_/.test(line)) {
      problems.push(`${at}: reads a server key directly — use _shared/service-key.ts`);
    }
    if (rel !== RESOLVER && /Bearer \$\{[^}]*(service|SERVICE|secretKey|SECRET_KEY|\.key\b)/.test(line)) {
      problems.push(`${at}: sends a server key as a Bearer token — use storageAuthHeaders()`);
    }
    if (/functions\/v1\/account-export/.test(line)) {
      problems.push(`${at}: calls account-export over HTTP — use _shared/account-export-cleanup.ts`);
    }
  });
}
for (const dir of ['app', 'components', 'hooks', 'lib']) {
  let files = [];
  try {
    files = walk(join(root, dir));
  } catch {
    continue;
  }
  for (const file of files) {
    code(readFileSync(file, 'utf8')).forEach((line, i) => {
      if (/SERVICE_ROLE|SECRET_KEYS|sb_secret_/.test(line)) problems.push(`${relative(root, file)}:${i + 1}: server key referenced in app code`);
    });
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('OK: server keys are read only by _shared/service-key.ts, never sent as Bearer tokens or between functions, and absent from app code.');
