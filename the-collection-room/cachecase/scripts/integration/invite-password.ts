/// <reference types="node" />
// Invite redemption password rules — end-to-end against the LOCAL Supabase
// stack. Seeds disposable invites (only the SHA-256 of each code is stored,
// exactly as grant-waitlist-access does) and calls redeem-waitlist-invite.
//
// Checks the server-side rule matches the app (lib/password-policy.ts): at
// least 8 characters, at most 72 UTF-8 bytes; that a refused password
// creates nothing and leaves the invite usable; and that eligibility,
// single use and email matching are unchanged. Codes and passwords are never
// printed.
//
// Prerequisites: local Supabase, and the functions served:
//   supabase functions serve --env-file <local functions env>
// Run (Node 24 runs .ts directly):  node scripts/integration/invite-password.ts
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const client = () => createClient(st.API_URL, st.ANON_KEY, opts);
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const MINE = /^iv[0-9a-f]{6}[a-z]@example\.test$/;

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newCode = () => Array.from({ length: 20 }, () => ALPHABET[randomInt(32)]).join('');
const display = (c: string) => c.match(/.{5}/g)!.join('-');
const hash = (c: string) => createHash('sha256').update(c).digest('hex');

type Invite = { email: string; username: string; code: string };
async function seedInvite(key: string): Promise<Invite> {
  const email = `iv${run}${key}@example.test`;
  const code = newCode();
  const { error } = await admin.from('waitlist_signups').insert({
    name: `Invite ${key}`, email, status: 'access_granted', access_code: hash(code),
    access_granted_at: new Date().toISOString(), access_code_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  if (error) throw new Error(`seed invite: ${error.message}`);
  return { email, username: `iv${run}${key}`, code: display(code) };
}
async function redeem(body: Record<string, unknown>) {
  const r = await fetch(`${st.API_URL}/functions/v1/redeem-waitlist-invite`, {
    method: 'POST', headers: { 'content-type': 'application/json', apikey: st.ANON_KEY }, body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}
const userFor = async (email: string) => (await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email) ?? null;
const inviteRow = async (email: string) => (await admin.from('waitlist_signups').select('status, onboarded_at, onboarded_user_id').eq('email', email).single()).data;
const untouched = async (inv: Invite) => {
  const row = await inviteRow(inv.email);
  return !(await userFor(inv.email)) && row?.status === 'access_granted' && !row.onboarded_at && !row.onboarded_user_id;
};

async function sweep() {
  const users = (await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.filter((u) => MINE.test(u.email ?? ''));
  for (const u of users) await admin.auth.admin.deleteUser(u.id);
  const { data } = await admin.from('waitlist_signups').select('id, email').like('email', 'iv%@example.test');
  const rows = (data ?? []).filter((r) => MINE.test(r.email));
  if (rows.length) await admin.from('waitlist_signups').delete().in('id', rows.map((r) => r.id));
  return users.length + rows.length;
}

async function main() {
  const ping = await fetch(`${st.API_URL}/functions/v1/redeem-waitlist-invite`, { method: 'OPTIONS' }).catch(() => null);
  if (!ping || ping.status >= 500) throw new Error('Edge Functions are not served locally (supabase functions serve).');
  const A = await seedInvite('a');
  const B = await seedInvite('b');
  const C = await seedInvite('c');
  const D = await seedInvite('d');
  const pw = (n: number) => {
    const p = `Iv-${randomBytes(96).toString('base64url')}`.slice(0, n);
    if (p.length !== n) throw new Error('test password generator too short');
    return p;
  };

  step('1. Too short (under 8 characters) is refused and creates nothing');
  for (const [label, password] of [['6 characters (the old minimum)', pw(6)], ['7 characters', pw(7)], ['7 multibyte characters', 'ééééééé']] as const) {
    const r = await redeem({ code: A.code, email: A.email, username: A.username, password });
    check(`${label} → 400 invalid_password`, r.status === 400 && r.body.reason === 'invalid_password', r);
  }
  for (const [label, password] of [['8 spaces', ' '.repeat(8)], ['20 mixed whitespace (spaces, tabs, newlines, no-break spaces)', ' \t\n\u00a0'.repeat(5)]] as const) {
    const r = await redeem({ code: A.code, email: A.email, username: A.username, password });
    check(`all whitespace, ${label} → 400 invalid_password`, r.status === 400 && r.body.reason === 'invalid_password', r);
  }
  check('…no account was created and the invite is still unused', await untouched(A));

  step('2. Over 72 bytes is refused (counted in UTF-8 bytes)');
  for (const [label, password] of [['73 ASCII characters', pw(73)], ['37 characters / 73 bytes (é×36 + a)', 'é'.repeat(36) + 'a'],
    ['25 characters / 75 bytes (€×25)', '€'.repeat(25)]] as const) {
    const r = await redeem({ code: A.code, email: A.email, username: A.username, password });
    check(`${label} → 400 invalid_password`, r.status === 400 && r.body.reason === 'invalid_password', r);
  }
  check('…no account was created and the invite is still unused', await untouched(A));

  step('3. Valid passwords redeem: exactly 8 characters; 72 multibyte bytes');
  const pwA = pw(8);
  const okA = await redeem({ code: A.code, email: A.email, username: A.username, password: pwA });
  check('8 characters → 200 redeemed', okA.status === 200 && okA.body.result === 'redeemed', okA);
  const rowA = await inviteRow(A.email);
  const userA = await userFor(A.email);
  check('…the account exists, its email is confirmed, the invite is onboarded and bound to it',
    !!userA && !!userA.email_confirmed_at && rowA?.status === 'onboarded' && rowA.onboarded_user_id === userA.id, rowA);
  const { data: profA } = await admin.from('profiles').select('username').eq('id', userA?.id ?? '').maybeSingle();
  check('…with its profile and username', profA?.username === A.username, profA);
  check('…and the password signs in', !(await client().auth.signInWithPassword({ email: A.email, password: pwA })).error);
  const pwC = '€'.repeat(24); // 24 characters, 72 bytes
  const okC = await redeem({ code: C.code, email: C.email, username: C.username, password: pwC });
  check('24 characters / 72 bytes (€×24) → 200 redeemed', okC.status === 200 && okC.body.result === 'redeemed', okC);
  check('…and that password signs in', !(await client().auth.signInWithPassword({ email: C.email, password: pwC })).error);
  const pwD = ` ${pw(6)} ${pw(6)} `; // spaces inside and around a real password
  const okD = await redeem({ code: D.code, email: D.email, username: D.username, password: pwD });
  check('a password containing (and surrounded by) spaces → 200 redeemed', okD.status === 200 && okD.body.result === 'redeemed', okD);
  check('…and signs in exactly as typed, spaces included', !(await client().auth.signInWithPassword({ email: D.email, password: pwD })).error);

  step('4. Eligibility, single use and email matching are unchanged');
  const again = await redeem({ code: A.code, email: A.email, username: A.username, password: pwA });
  check('the same invite, same details → 200 already_redeemed (idempotent retry)', again.status === 200 && again.body.result === 'already_redeemed', again);
  const reuse = await redeem({ code: A.code, email: B.email, username: B.username, password: pw(12) });
  check('a used invite with another email → 409 (refused)', reuse.status === 409, reuse);
  const mismatch = await redeem({ code: B.code, email: `iv${run}x@example.test`, username: `iv${run}x`, password: pw(12) });
  check('a valid invite with the wrong email → 409 email_mismatch', mismatch.status === 409 && mismatch.body.reason === 'email_mismatch', mismatch);
  const unknown = await redeem({ code: display(newCode()), email: B.email, username: B.username, password: pw(12) });
  check('an unknown code → 409 invalid', unknown.status === 409 && unknown.body.reason === 'invalid', unknown);
  check('…none of these created an account for B or the wrong address, and B is still unused',
    (await untouched(B)) && !(await userFor(`iv${run}x@example.test`)));
  await admin.from('waitlist_signups').update({ access_code_expires_at: new Date(Date.now() - 1000).toISOString() }).eq('email', B.email);
  const expired = await redeem({ code: B.code, email: B.email, username: B.username, password: pw(12) });
  check('an expired invite → 409 expired', expired.status === 409 && expired.body.reason === 'expired', expired);
}

console.log(`Local Supabase ${st.API_URL} (run ${run})`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture row(s)/account(s).`);
let fatal: unknown = null;
try {
  await main();
} catch (e) {
  fatal = e;
  console.error(`\nAborted: ${(e as Error).message}`);
} finally {
  console.log(`\nCleanup: ${await sweep()} fixture row(s)/account(s) removed.`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;
