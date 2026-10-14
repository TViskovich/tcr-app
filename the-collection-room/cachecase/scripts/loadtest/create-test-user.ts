/// <reference types="node" />
// Provisions the 30 synthetic load-test accounts (lt_user_01 … lt_user_30)
// in the CacheCase STAGING Supabase project via the Auth Admin API, then
// verifies that the on_auth_user_created trigger produced each account's
// public.profiles row.
//
// Every account is checked BEFORE anything is created: an existing account
// that isn't tagged seed=loadtest-v1, a username already held by another
// account, or any extra loadtest-v1 account outside the expected 30 aborts
// the whole run. Missing accounts are then created one at a time with a
// short pause between them; the first failure stops the run.
//
// Run manually only (Node 24 runs .ts directly — no extra tooling):
//   node scripts/loadtest/create-test-user.ts
//
// Staging-only config and production safeguards: see ./staging.ts.
//
// Safe to re-run: an existing tagged account with the same email is reused
// (never recreated or modified — its password is left as it was). All new
// accounts share LOADTEST_USER_PASSWORD. No email is sent (email_confirm:
// true, and no invite/magic-link/recovery API is called). Creates no other
// data.

import {
  ConfigError,
  SEED_TAG,
  createAdminClient,
  loadStagingConfig,
  requireSetting,
  runMain,
  sleep,
} from './staging.ts';

const ACCOUNT_COUNT = 30;
// Pause between createUser calls, so 29 creations don't burst the Auth API.
const CREATE_DELAY_MS = 750;
const LIST_PAGE_SIZE = 200;

type Account = { username: string; displayName: string; emailLocalPart: string };

// lt_user_01 / Load Test 01 / lt-user-01 … lt_user_30 / Load Test 30 / lt-user-30
const ACCOUNTS: Account[] = Array.from({ length: ACCOUNT_COUNT }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return { username: `lt_user_${n}`, displayName: `Load Test ${n}`, emailLocalPart: `lt-user-${n}` };
});

function assertEmailDomain(domain: string) {
  if (!/^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) {
    throw new ConfigError('LOADTEST_EMAIL_DOMAIN must be a bare domain such as loadtest.yourdomain.com.');
  }
}

function assertPassword(password: string) {
  if (password.length < 12) {
    throw new ConfigError('LOADTEST_USER_PASSWORD must be at least 12 characters.');
  }
}

async function main() {
  const config = loadStagingConfig();
  const emailDomain = requireSetting(config, 'LOADTEST_EMAIL_DOMAIN').toLowerCase();
  const password = requireSetting(config, 'LOADTEST_USER_PASSWORD');
  assertEmailDomain(emailDomain);
  assertPassword(password);

  console.log(`Target project: ${config.ref} (staging)`);

  const admin = createAdminClient(config);

  const emailFor = (a: Account) => `${a.emailLocalPart}@${emailDomain}`;
  const expectedEmails = new Set(ACCOUNTS.map(emailFor));

  // ── Preflight: nothing is created unless every account checks out ──────

  // Every existing auth user, by email (listUsers has no email filter).
  const usersByEmail = new Map<string, { id: string; app_metadata: Record<string, unknown> }>();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: LIST_PAGE_SIZE });
    if (error) throw new Error(`Listing users failed: ${error.message}`);
    for (const u of data.users) {
      if (u.email) usersByEmail.set(u.email.toLowerCase(), u);
    }
    if (data.users.length < LIST_PAGE_SIZE) break;
  }

  // Exactly 30 tagged accounts in total — refuse if any other account
  // already carries this seed's tag.
  const strayTagged = [...usersByEmail].filter(
    ([email, u]) => u.app_metadata?.seed === SEED_TAG && !expectedEmails.has(email),
  );
  if (strayTagged.length) {
    throw new Error(
      `${strayTagged.length} other account(s) are already tagged seed=${SEED_TAG} outside lt-user-01…${ACCOUNT_COUNT}; nothing was created.`,
    );
  }

  // Never adopt or modify an account this seed didn't create.
  const untagged = ACCOUNTS.filter((a) => {
    const u = usersByEmail.get(emailFor(a));
    return u && u.app_metadata?.seed !== SEED_TAG;
  });
  if (untagged.length) {
    throw new Error(
      `Existing account(s) not tagged seed=${SEED_TAG}: ${untagged.map((a) => a.username).join(', ')}. Left untouched; nothing was created.`,
    );
  }

  // Each username must be free, or held by that same tagged account —
  // otherwise the profile trigger would reject the new user.
  const { data: takenRows, error: takenError } = await admin
    .from('profiles')
    .select('id, username')
    .in('username', ACCOUNTS.map((a) => a.username));
  if (takenError) throw new Error(`Username check failed: ${takenError.message}`);
  const takenBy = new Map((takenRows ?? []).map((r) => [r.username as string, r.id as string]));
  const conflicts = ACCOUNTS.filter((a) => {
    const holder = takenBy.get(a.username);
    return holder && holder !== usersByEmail.get(emailFor(a))?.id;
  });
  if (conflicts.length) {
    throw new Error(
      `Username(s) already used by another account: ${conflicts.map((a) => a.username).join(', ')}. Nothing was created.`,
    );
  }

  // ── Create missing accounts, one at a time ─────────────────────────────

  const userIds = new Map<string, string>();
  const created: string[] = [];
  const reused: string[] = [];
  const failed: { username: string; reason: string }[] = [];

  try {
    let createdAny = false;
    for (const account of ACCOUNTS) {
      const existing = usersByEmail.get(emailFor(account));
      if (existing) {
        userIds.set(account.username, existing.id);
        reused.push(account.username);
        console.log(`  ${account.username}: already exists — reused`);
        continue;
      }

      if (createdAny) await sleep(CREATE_DELAY_MS);
      createdAny = true;

      const { data, error } = await admin.auth.admin.createUser({
        email: emailFor(account),
        password,
        email_confirm: true,
        user_metadata: { username: account.username, display_name: account.displayName },
        app_metadata: { seed: SEED_TAG },
      });
      if (error || !data.user) {
        failed.push({ username: account.username, reason: error?.message ?? 'no user returned' });
        throw new Error(`Creating ${account.username} failed; stopped before the remaining accounts.`);
      }
      userIds.set(account.username, data.user.id);
      created.push(account.username);
      console.log(`  ${account.username}: created`);
    }

    // ── Verify every account's public.profiles row ───────────────────────

    const { data: profiles, error: profilesError } = await admin
      .from('profiles')
      .select('id, username, account_number')
      .in('id', [...userIds.values()]);
    if (profilesError) throw new Error(`Profile verification failed: ${profilesError.message}`);
    const profilesById = new Map((profiles ?? []).map((p) => [p.id as string, p]));
    for (const account of ACCOUNTS) {
      const profile = profilesById.get(userIds.get(account.username)!);
      if (!profile) {
        failed.push({ username: account.username, reason: 'no public.profiles row' });
      } else if (profile.username !== account.username) {
        failed.push({ username: account.username, reason: `profile username is "${profile.username}"` });
      }
    }
    if (failed.length) throw new Error('Profile verification found problems (see summary).');

    const numbers = (profiles ?? []).map((p) => p.account_number as number).sort((a, b) => a - b);
    console.log(`All ${ACCOUNT_COUNT} profiles verified (account numbers ${numbers[0]}–${numbers[numbers.length - 1]}).`);
  } finally {
    console.log('');
    console.log('Summary');
    console.log(`  created: ${created.length}${created.length ? ` (${created.join(', ')})` : ''}`);
    console.log(`  reused:  ${reused.length}`);
    console.log(`  failed:  ${failed.length}`);
    for (const f of failed) console.log(`    ${f.username}: ${f.reason}`);
    const notReached = ACCOUNT_COUNT - created.length - reused.length - failed.filter((f) => !userIds.has(f.username)).length;
    if (notReached > 0) console.log(`  not attempted: ${notReached}`);
  }
}

runMain(main);
