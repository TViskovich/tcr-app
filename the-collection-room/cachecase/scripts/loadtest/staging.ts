/// <reference types="node" />
// Shared staging-only configuration and production-target safeguards for
// every scripts/loadtest/ script.
//
// Configuration is read ONLY from scripts/loadtest/.env.staging.local
// (git-ignored by the repo's `.env*.local` rule; see the .example file next
// to this one). It is parsed into a private object rather than loaded into
// process.env, so a stray shell variable — e.g. a production key — can never
// be picked up instead.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const STAGING_PROJECT_REF = 'ickqkzvqddkhqyxnbzox';
export const PRODUCTION_PROJECT_REF = 'izlrxenomerfeqhmlyre';

// app_metadata.seed on every synthetic account; everything a seed script
// generates is owned by (or keyed to) accounts carrying this tag.
export const SEED_TAG = 'loadtest-v1';

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '.env.staging.local');

export class ConfigError extends Error {}

export type StagingConfig = {
  url: string;
  ref: string;
  serviceRoleKey: string;
  // Script-specific values (e.g. LOADTEST_EMAIL_DOMAIN) — read via requireSetting.
  settings: Record<string, string | undefined>;
};

function readSettings(): Record<string, string | undefined> {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    throw new ConfigError(
      `Missing config file scripts/loadtest/.env.staging.local — copy .env.staging.local.example and fill it in.`,
    );
  }
  const settings = parseEnv(raw) as Record<string, string | undefined>;

  const exposed = Object.keys(settings).filter((k) => k.startsWith('EXPO_PUBLIC_'));
  if (exposed.length) {
    throw new ConfigError(`EXPO_PUBLIC_ variables are not allowed in this file (found: ${exposed.join(', ')}).`);
  }
  return settings;
}

// Reads and validates the staging URL and service-role key. Throws
// ConfigError (never logging either value) unless both belong to staging.
export function loadStagingConfig(): StagingConfig {
  const config = { settings: readSettings() } as StagingConfig;
  config.url = requireSetting(config, 'STAGING_SUPABASE_URL');
  config.serviceRoleKey = requireSetting(config, 'STAGING_SUPABASE_SERVICE_ROLE_KEY');
  config.ref = assertStagingUrl(config.url);
  assertServiceKey(config.serviceRoleKey);
  return config;
}

export type StagingUserConfig = Omit<StagingConfig, 'serviceRoleKey'> & { anonKey: string };

// For tests that must act exactly like the app: the staging URL and the
// public anon key only. The service-role key is never read here — the
// returned config has no way to bypass RLS.
export function loadStagingUserConfig(): StagingUserConfig {
  const config = { settings: readSettings() } as StagingUserConfig;
  config.url = requireSetting(config, 'STAGING_SUPABASE_URL');
  config.anonKey = requireSetting(config, 'STAGING_SUPABASE_ANON_KEY');
  config.ref = assertStagingUrl(config.url);
  // Compared, never read into the config: a service-role key pasted into the
  // anon slot would silently bypass every RLS check under test.
  if (config.anonKey === config.settings.STAGING_SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new ConfigError('STAGING_SUPABASE_ANON_KEY is the service-role key; it must be the public anon key.');
  }
  assertAnonKey(config.anonKey);
  return config;
}

export function requireSetting(config: Pick<StagingConfig, 'settings'>, name: string): string {
  const value = config.settings[name]?.trim();
  if (!value) throw new ConfigError(`${name} is not set in scripts/loadtest/.env.staging.local.`);
  return value;
}

// The URL must be exactly https://<staging-ref>.supabase.co — anything else
// (production, a custom domain, a local instance) is refused.
function assertStagingUrl(url: string): string {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error();
    host = parsed.hostname.toLowerCase();
  } catch {
    throw new ConfigError('STAGING_SUPABASE_URL is not a valid https URL.');
  }
  const ref = host.endsWith('.supabase.co') ? host.slice(0, -'.supabase.co'.length) : null;
  if (ref === PRODUCTION_PROJECT_REF || url.includes(PRODUCTION_PROJECT_REF)) {
    throw new ConfigError('Refusing to run: STAGING_SUPABASE_URL points at the PRODUCTION project.');
  }
  if (ref !== STAGING_PROJECT_REF) {
    throw new ConfigError(`Refusing to run: STAGING_SUPABASE_URL is not the staging project (${STAGING_PROJECT_REF}).`);
  }
  return ref;
}

// A legacy JWT service-role key carries its project ref and role — check
// both. A new-format secret key (sb_secret_...) carries neither; it only
// authenticates against its own project, so a mismatch fails at the API.
function assertServiceKey(key: string) {
  if (key.startsWith('sb_publishable_')) {
    throw new ConfigError('STAGING_SUPABASE_SERVICE_ROLE_KEY is a publishable key, not a secret/service-role key.');
  }
  if (key.startsWith('sb_secret_')) return;

  const parts = key.split('.');
  let claims: { ref?: string; role?: string } = {};
  try {
    if (parts.length !== 3) throw new Error();
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new ConfigError('STAGING_SUPABASE_SERVICE_ROLE_KEY is not a recognised Supabase key format.');
  }
  if (claims.ref === PRODUCTION_PROJECT_REF) {
    throw new ConfigError('Refusing to run: the service-role key belongs to the PRODUCTION project.');
  }
  if (claims.ref !== STAGING_PROJECT_REF) {
    throw new ConfigError('Refusing to run: the service-role key does not belong to the staging project.');
  }
  if (claims.role !== 'service_role') {
    throw new ConfigError(`STAGING_SUPABASE_SERVICE_ROLE_KEY has role "${claims.role ?? 'unknown'}", expected service_role.`);
  }
}

// Same shape as assertServiceKey, inverted: a legacy JWT must be staging's
// and have role anon; a new-format key must be publishable, never secret.
function assertAnonKey(key: string) {
  if (key.startsWith('sb_secret_')) {
    throw new ConfigError('STAGING_SUPABASE_ANON_KEY is a secret key; it must be the public anon/publishable key.');
  }
  if (key.startsWith('sb_publishable_')) return;

  const parts = key.split('.');
  let claims: { ref?: string; role?: string } = {};
  try {
    if (parts.length !== 3) throw new Error();
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new ConfigError('STAGING_SUPABASE_ANON_KEY is not a recognised Supabase key format.');
  }
  if (claims.ref === PRODUCTION_PROJECT_REF) {
    throw new ConfigError('Refusing to run: the anon key belongs to the PRODUCTION project.');
  }
  if (claims.ref !== STAGING_PROJECT_REF) {
    throw new ConfigError('Refusing to run: the anon key does not belong to the staging project.');
  }
  if (claims.role !== 'anon') {
    throw new ConfigError(`STAGING_SUPABASE_ANON_KEY has role "${claims.role ?? 'unknown'}", expected anon.`);
  }
}

// A normal, app-equivalent client: anon key, no persisted session. Sign in
// on it to act as a user; every query then goes through RLS.
export function createUserClient(config: StagingUserConfig): SupabaseClient {
  return createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function createAdminClient(config: StagingConfig): SupabaseClient {
  return createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared entry-point wrapper: prints only the error message (never a key or
// a full connection string) and sets a failing exit code.
export function runMain(main: () => Promise<void>) {
  main().catch((e: unknown) => {
    console.error(`Error: ${e instanceof Error ? e.message : 'unexpected failure'}`);
    process.exitCode = 1;
  });
}
