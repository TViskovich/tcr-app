#!/usr/bin/env node
// Edge Function JWT-setting guard.
//
// `supabase functions deploy` takes each function's gateway JWT setting from
// supabase/config.toml and silently defaults an UNLISTED function to
// verify_jwt = true. Redeploying could therefore switch the check on for a
// production function that must accept callers without a session. This
// check never relies on that default.
//
// Local (default): every function folder in supabase/functions has an
// explicit verify_jwt in config.toml, equal to the documented baseline
// (scripts/deploy/function-jwt-baseline.json); config.toml lists no function
// that doesn't exist; production-only functions are not in the repo.
//
//   npm run check:function-jwt
//
// Remote (read-only): additionally compares the HOSTED settings, from
// `supabase functions list`, against the baseline. Run it before and after
// every production function deploy.
//
//   npm run check:function-jwt -- --remote <project-ref>
//   …or: node scripts/deploy/check-function-jwt.mjs --remote <project-ref>
//
// Exit status 0 = everything matches; 1 = a difference (each one printed).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseline = JSON.parse(readFileSync(join(root, 'scripts/deploy/function-jwt-baseline.json'), 'utf8'));
const remoteIndex = process.argv.indexOf('--remote');
const remoteRef = remoteIndex > -1 ? process.argv[remoteIndex + 1] : null;
if (remoteIndex > -1 && !/^[a-z0-9]{20}$/.test(remoteRef ?? '')) {
  console.error('usage: check-function-jwt.mjs [--remote <project-ref>]');
  process.exit(2);
}

// The [functions.<name>] tables of config.toml and their verify_jwt values.
// (A deliberately small parser: config.toml must use the simple form
// `[functions.name]` followed by `verify_jwt = true|false`.)
export function parseFunctionConfig(toml) {
  const out = new Map();
  let current = null;
  for (const raw of toml.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const table = line.match(/^\[([^\]]+)\]$/);
    if (table) {
      const m = table[1].match(/^functions\.("?)([A-Za-z0-9_-]+)\1$/);
      current = m ? m[2] : null;
      if (current && !out.has(current)) out.set(current, undefined);
      continue;
    }
    const kv = line.match(/^verify_jwt\s*=\s*(\S+)$/);
    if (current && kv) out.set(current, kv[1] === 'true' ? true : kv[1] === 'false' ? false : kv[1]);
  }
  return out;
}

const problems = [];
const config = parseFunctionConfig(readFileSync(join(root, 'supabase/config.toml'), 'utf8'));
const fnDir = join(root, 'supabase/functions');
const local = readdirSync(fnDir).filter((n) => !n.startsWith('_') && !n.startsWith('.') && statSync(join(fnDir, n)).isDirectory()).sort();
const expected = baseline.functions;
const productionOnly = baseline.production_only ?? {};

for (const name of local) {
  const want = expected[name];
  const have = config.get(name);
  if (!want) problems.push(`${name}: in supabase/functions but not in the baseline — add its intended verify_jwt to function-jwt-baseline.json`);
  if (have === undefined) problems.push(`${name}: no explicit verify_jwt in config.toml (the CLI would default it to true)`);
  else if (typeof have !== 'boolean') problems.push(`${name}: verify_jwt in config.toml is not true/false (${have})`);
  else if (want && have !== want.verify_jwt) problems.push(`${name}: config.toml verify_jwt = ${have}, baseline ${want.verify_jwt}`);
}
for (const name of config.keys()) {
  if (!local.includes(name)) problems.push(`${name}: listed in config.toml but has no folder in supabase/functions`);
}
for (const name of Object.keys(expected)) {
  if (!local.includes(name)) problems.push(`${name}: in the baseline but has no folder in supabase/functions`);
}
for (const name of Object.keys(productionOnly)) {
  if (local.includes(name)) problems.push(`${name}: marked production-only but now exists locally — move it into "functions"`);
}
console.log(`Local: ${local.length} functions, ${[...config.values()].filter((v) => v === false).length} with verify_jwt = false.`);

if (remoteRef) {
  let hosted;
  try {
    const out = execFileSync('supabase', ['functions', 'list', '--project-ref', remoteRef, '-o', 'json'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    hosted = JSON.parse(out.slice(out.indexOf('[')));
  } catch (e) {
    console.error(`Could not list functions for ${remoteRef}: ${e.message.split('\n')[0]}`);
    process.exit(1);
  }
  const bySlug = new Map(hosted.map((f) => [f.slug, f]));
  const all = { ...expected, ...productionOnly };
  for (const [name, want] of Object.entries(all)) {
    const f = bySlug.get(name);
    if (!f) {
      if (want.deployed === false) continue; // not deployed yet: nothing to compare
      problems.push(`${name}: expected on ${remoteRef} but not deployed`);
      continue;
    }
    if (f.verify_jwt !== want.verify_jwt) problems.push(`${name}: HOSTED verify_jwt = ${f.verify_jwt}, expected ${want.verify_jwt}`);
  }
  for (const slug of bySlug.keys()) {
    if (!all[slug]) problems.push(`${slug}: deployed on ${remoteRef} but not in the baseline`);
  }
  const pending = Object.entries(expected).filter(([n, w]) => w.deployed === false && !bySlug.has(n)).map(([n]) => n);
  console.log(`Remote ${remoteRef}: ${hosted.length} deployed${pending.length ? `; not deployed yet: ${pending.join(', ')}` : ''}.`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('OK: every function has an explicit verify_jwt matching the baseline.');
