import type { ConfigContext, ExpoConfig } from 'expo/config';

// Lets a development-client build coexist on the same iPhone as the
// TestFlight/production app instead of colliding over one bundle identity.
// `config` here is already the fully-parsed app.json — production's own
// values (name, bundleIdentifier app.cachecase, scheme cachecase, icon,
// plugins, etc.) stay exactly as app.json defines them whenever APP_VARIANT
// isn't "development", so a plain `eas build --profile production` (or any
// build that doesn't set APP_VARIANT) is byte-for-byte what app.json alone
// used to produce. Only the development branch below overrides the handful
// of fields that need to differ for a separate installable app.
const IS_DEV = process.env.APP_VARIANT === 'development';

export default ({ config }: ConfigContext): ExpoConfig => {
  if (!IS_DEV) return config as ExpoConfig;

  return {
    ...config,
    name: 'CacheCase Dev',
    // Separate from production's "cachecase" scheme so the dev client's own
    // deep links/URL scheme registration can never be resolved by iOS to
    // the already-installed TestFlight app (or vice versa).
    scheme: 'cachecase-dev',
    ios: {
      ...config.ios,
      bundleIdentifier: 'app.cachecase.dev',
    },
  } as ExpoConfig;
};
