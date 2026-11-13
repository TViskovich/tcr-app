/// <reference types="node" />
// Test-fixture cleanup for the private moderation-quarantine bucket (LOCAL
// stack only).
//
// Since 20261124120000 no API role — the service role included — can delete a
// quarantine copy without a live, two-admin purge claim, and no executor
// exists yet. Integration scripts therefore remove THEIR OWN fixture copies
// the way a database operator would: a superuser psql session (the existing,
// unchanged operator exemption) deletes the object rows, and the matching
// blobs are removed from the local Storage container's file backend. Only
// paths of the exact quarantine shape q/<uuid>/original are accepted, so
// nothing else can be touched. Never point this at a hosted project.
import { execFileSync } from 'node:child_process';

import { localStack } from './local-stack.ts';

const BLOB_ROOT = '/mnt/stub/stub/moderation-quarantine';
const PATH_SHAPE = /^q\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/original$/;

export function removeQuarantineFixtures(paths: string[]): number {
  const safe = [...new Set(paths)].filter((p) => PATH_SHAPE.test(p));
  if (safe.length !== new Set(paths).size) throw new Error('Refusing: a quarantine path does not have the q/<uuid>/original shape.');
  if (!safe.length) return 0;
  const { db: DB, storage: STORAGE } = localStack();
  const list = safe.map((p) => `'${p}'`).join(',');
  execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc',
    `BEGIN; SET LOCAL storage.allow_delete_query = 'true';
     DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name IN (${list}); COMMIT;`], { encoding: 'utf8' });
  execFileSync('docker', ['exec', STORAGE, 'rm', '-rf', ...safe.map((p) => `${BLOB_ROOT}/${p.slice(0, -'/original'.length)}`)], { encoding: 'utf8' });
  return safe.length;
}
