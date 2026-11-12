/// <reference types="node" />
// Which LOCAL Supabase stack an integration script talks to.
//
// Default: the primary local stack (project "cachecase", started from this
// repository). Set CACHECASE_STACK_WORKDIR to the working directory of a
// disposable, isolated local stack (`supabase start --workdir <dir>`, with its
// own project_id) to target that one instead — destructive scripts require it.
// Hosted projects are always refused.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type LocalStack = {
  st: Record<string, string>;
  project: string;
  db: string;        // Postgres container
  storage: string;   // Storage API container
  isolated: boolean; // a disposable stack other than the primary one
};

export function localStack(): LocalStack {
  const workdir = process.env.CACHECASE_STACK_WORKDIR;
  const raw = execFileSync('supabase', ['status', '-o', 'json', ...(workdir ? ['--workdir', workdir] : [])],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
  let project = 'cachecase';
  if (workdir) {
    const m = readFileSync(`${workdir}/supabase/config.toml`, 'utf8').match(/^project_id\s*=\s*"([a-z0-9_-]+)"/m);
    if (!m) throw new Error('Refusing: no project_id in the isolated stack config.');
    project = m[1];
  }
  return { st, project, db: `supabase_db_${project}`, storage: `supabase_storage_${project}`, isolated: project !== 'cachecase' };
}

// Destructive scripts call this first.
export function requireIsolatedStack(): LocalStack {
  const s = localStack();
  if (!s.isolated) {
    throw new Error('Refusing: destructive retention-purge tests run only on an isolated disposable stack (set CACHECASE_STACK_WORKDIR).');
  }
  return s;
}
