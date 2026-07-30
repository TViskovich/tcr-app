// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // Deno Edge Functions — a separate runtime (npm: specifiers, global
    // Deno) that this Node-resolver-based config was never meant to lint.
    // Mirrors tsconfig.json's exclude for the same directory.
    ignores: ['dist/*', 'supabase/functions/**'],
  },
]);
