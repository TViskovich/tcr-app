// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // Deno Edge Functions — a separate runtime (npm: specifiers, global
    // Deno) that this Node-resolver-based config was never meant to lint.
    // Mirrors tsconfig.json's exclude for the same directory.
    //
    // public-web, .expo, and reference are all outside this config's
    // remit: .expo/types is Expo Router's generated route types,
    // reference/figma-profile is a standalone Figma-exported snippet with
    // its own, unrelated dependency set, and public-web is a distinct
    // Next.js subproject with its own package.json, its own lint script,
    // and its own public-web/eslint.config.mjs (Next-specific plugins/
    // rules this Expo/React Native config doesn't have and shouldn't try
    // to approximate). Linting any of them through this config produces
    // findings that are either noise (generated output) or actively
    // misleading (public-web source evaluated under the wrong plugin set —
    // e.g. import/no-unresolved on its own valid `@/*` paths, and a
    // missing-rule-definition error for @next/next/no-img-element, which
    // only exists under its own config). public-web must always be linted
    // independently, from inside public-web/, via its own `npm run lint` —
    // never through this root config.
    ignores: [
      'dist/*',
      'supabase/functions/**',
      'public-web/**',
      'reference/**',
      '.expo/**',
    ],
  },
]);
