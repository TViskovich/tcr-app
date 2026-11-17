// CacheCase's public website pages that the app links to. One place for
// every cachecase.com page URL, so a link is never duplicated across
// screens. Pure (no React Native imports) so it is unit tested:
//   node --test lib/cachecase-website.test.ts
//
// Pages open in the in-app browser (expo-web-browser), the same convention
// as the Dashboard's Support links: the collector stays signed in to the
// app, and the browser's Done button returns them to the screen they left.
// (The support email address lives in lib/support-contact.ts.)

export const CACHECASE_WEBSITE_ORIGIN = 'https://cachecase.com';

// Dashboard → How CacheCase Works.
export const CACHECASE_FEATURES_URL = `${CACHECASE_WEBSITE_ORIGIN}/features`;
