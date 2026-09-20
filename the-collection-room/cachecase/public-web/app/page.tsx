import styles from './page.module.css';

// This is where "Learn More About CacheCase" (see
// components/registry/app-actions.tsx) points — a minimal, factual landing
// page rather than an external marketing URL this project has no way to
// confirm exists. No boilerplate/logos from create-next-app remain here.
export default function HomePage() {
  return (
    <main className={styles.page}>
      <p className={styles.brand}>CacheCase Registry</p>

      <h1 className={styles.title}>Public card registry lookup</h1>

      <p className={styles.body}>
        CacheCase is a mobile app for cataloging and registering physical trading card
        collections. Every registered card gets a unique CC-ID and a public registry page at{' '}
        <code className={styles.code}>cachecase.app/registry/&lt;cc-id&gt;</code>, showing its
        current custody status and public ownership history &mdash; visible to anyone with the
        link, no account required.
      </p>

      <p className={styles.body}>
        This page does not verify card authenticity or grading. It reflects only what the
        card&apos;s owner has recorded in the CacheCase registry.
      </p>
    </main>
  );
}
