import Link from 'next/link';
import styles from './app-actions.module.css';

// "Open in CacheCase" is intentionally disabled rather than wired to a
// guessed deep link. The Expo app's authenticated registry route
// (app/registry/[id].tsx) is keyed by the registered card's internal
// UUID, not its cc_id — and this public site never has that UUID (by
// design; see the security requirements this project was built under). No
// app route accepts a cc_id today, so there is no real target to link to.
// Wiring this up requires either a new cc_id-aware deep-link route in the
// Expo app or a server-side cc_id->id resolution step that doesn't exist
// yet — both are out of scope for this pass. Deferring rather than
// inventing a URL that would silently fail for every visitor.
export function AppActions() {
  return (
    <div className={styles.actions}>
      <button type="button" className={styles.primary} disabled title="Coming soon">
        Open in CacheCase
      </button>
      <Link href="/" className={styles.secondary}>
        Learn More About CacheCase
      </Link>
    </div>
  );
}
