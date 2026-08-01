import type { PublicRegistryEvent } from '@/lib/registry-api';
import { formatDate, formatEventType } from '@/lib/format';
import styles from './registry-timeline.module.css';

// Renders exactly what get-public-registry-card returned — event_type,
// created_at, display_detail — and nothing else. No hidden ids are read
// from these events (there are none in this shape to read), and
// item_linked/item_unlinked never appear here because the function itself
// already omits them before this component ever sees the array.
export function RegistryTimeline({ events }: { events: PublicRegistryEvent[] }) {
  if (events.length === 0) {
    return <p className={styles.empty}>No public history yet.</p>;
  }

  return (
    <ol className={styles.list}>
      {events.map((event, index) => (
        <li key={`${event.event_type}-${event.created_at}-${index}`} className={styles.item}>
          <div className={styles.marker} aria-hidden="true" />
          <div className={styles.content}>
            <div className={styles.row}>
              <span className={styles.type}>{formatEventType(event.event_type)}</span>
              <span className={styles.date}>{formatDate(event.created_at)}</span>
            </div>
            {event.display_detail && <p className={styles.detail}>{event.display_detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
