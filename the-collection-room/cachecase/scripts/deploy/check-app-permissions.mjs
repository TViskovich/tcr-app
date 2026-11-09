#!/usr/bin/env node
// Native permission guard for the store build.
//
// CacheCase only uses the camera and the photo library, for still images
// (every expo-image-picker call uses mediaTypes ['images']). It never records
// audio or video, so the build must not ask for the microphone. expo-image-
// picker's config plugin adds NSMicrophoneUsageDescription (iOS) and
// android.permission.RECORD_AUDIO unless it is configured with
// `microphonePermission: false` (app.json); with that setting the plugin also
// BLOCKS RECORD_AUDIO (tools:node="remove") so no other package can add it.
//
// This resolves the production config exactly as a build would
// (`expo config --type introspect`, APP_VARIANT=production) — the generated
// Info.plist and AndroidManifest permissions — without writing any native
// project files.
//
//   npm run check:app-permissions
//
// Exit status 0 = as expected; 1 = a difference (each one printed).
import { execFileSync } from 'node:child_process';

const raw = execFileSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
  encoding: 'utf8',
  env: { ...process.env, APP_VARIANT: 'production', CI: '1' },
  stdio: ['ignore', 'pipe', 'ignore'],
  maxBuffer: 1 << 26,
});
const config = JSON.parse(raw.slice(raw.indexOf('{')));

const problems = [];
const plist = config.ios?.infoPlist ?? {};
const permissions = (config._internal?.modResults?.android?.manifest?.manifest?.['uses-permission'] ?? []).map((p) => p.$ ?? {});
const requested = permissions.filter((p) => p['tools:node'] !== 'remove').map((p) => p['android:name']);
const blocked = permissions.filter((p) => p['tools:node'] === 'remove').map((p) => p['android:name']);

// No microphone, on either platform.
if ('NSMicrophoneUsageDescription' in plist) problems.push('iOS Info.plist declares NSMicrophoneUsageDescription');
if (requested.includes('android.permission.RECORD_AUDIO')) problems.push('Android requests RECORD_AUDIO');
if (!blocked.includes('android.permission.RECORD_AUDIO')) problems.push('Android does not block RECORD_AUDIO (expo-image-picker microphonePermission: false)');
if ((config.android?.permissions ?? []).includes('android.permission.RECORD_AUDIO')) problems.push('app.json android.permissions lists RECORD_AUDIO');

// Camera and photos stay, with CacheCase's own explanations.
for (const key of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription']) {
  if (typeof plist[key] !== 'string' || !plist[key].startsWith('Allow CacheCase')) problems.push(`iOS ${key} missing or not CacheCase's wording`);
}

// Location, contacts, tracking etc. were never part of the app; flag them if they ever appear.
for (const key of ['NSLocationWhenInUseUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription', 'NSContactsUsageDescription',
  'NSUserTrackingUsageDescription', 'NSSpeechRecognitionUsageDescription', 'NSBluetoothAlwaysUsageDescription']) {
  if (key in plist) problems.push(`iOS Info.plist declares ${key}`);
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL: ${p}`);
  process.exit(1);
}
console.log(`OK: no microphone permission (iOS key absent; Android RECORD_AUDIO blocked); camera and photo-library descriptions present. iOS usage keys: ${Object.keys(plist).filter((k) => k.endsWith('UsageDescription')).sort().join(', ')}.`);
