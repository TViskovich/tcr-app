import { formatCustodyStatus, isSevereCustodyStatus } from '@/lib/format';
import styles from './custody-badge.module.css';

export function CustodyBadge({ status }: { status: string }) {
  const severe = isSevereCustodyStatus(status);
  return (
    <span className={`${styles.badge} ${severe ? styles.severe : ''}`}>
      {formatCustodyStatus(status)}
    </span>
  );
}
