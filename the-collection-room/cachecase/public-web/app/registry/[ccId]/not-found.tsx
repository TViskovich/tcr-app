import Link from 'next/link';
import styles from './page.module.css';
import notFoundStyles from './not-found.module.css';

// Reached for BOTH a nonexistent cc_id and a private one — never
// distinguished, per spec. Also reached for a malformed cc_id that fails
// normalization before any network call is made.
export default function RegistryNotFound() {
  return (
    <main className={styles.page}>
      <div className={notFoundStyles.wrap}>
        <h1 className={notFoundStyles.title}>Registry record not found</h1>
        <p className={notFoundStyles.body}>
          This card may not be registered, or the record isn&apos;t publicly viewable.
        </p>
        <Link href="/" className={notFoundStyles.link}>
          Learn more about CacheCase
        </Link>
      </div>
    </main>
  );
}
