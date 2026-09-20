import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchPublicRegistryCard, normalizeCcId } from '@/lib/registry-api';
import { formatCustodyStatus, formatDate } from '@/lib/format';
import { CustodyBadge } from '@/components/registry/custody-badge';
import { SnapshotImage } from '@/components/registry/snapshot-image';
import { RegistryTimeline } from '@/components/registry/registry-timeline';
import { AppActions } from '@/components/registry/app-actions';
import styles from './page.module.css';

type PageProps = {
  params: Promise<{ ccId: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { ccId: rawCcId } = await params;
  const ccId = normalizeCcId(rawCcId);
  if (!ccId) {
    return { title: 'Registry record not found' };
  }

  const result = await fetchPublicRegistryCard(ccId);
  if (result.status !== 'ok') {
    return { title: 'Registry record not found' };
  }

  const { data } = result;
  const label = data.title ? `${data.title} · ${data.cc_id}` : data.cc_id;
  return {
    title: label,
    description: `CacheCase registry record ${data.cc_id}. Current custody status: ${formatCustodyStatus(data.custody_status)}.`,
  };
}

export default async function RegistryCardPage({ params }: PageProps) {
  const { ccId: rawCcId } = await params;
  const ccId = normalizeCcId(rawCcId);
  if (!ccId) {
    notFound();
  }

  const result = await fetchPublicRegistryCard(ccId);

  if (result.status === 'not_found') {
    notFound();
  }

  if (result.status === 'unavailable') {
    return (
      <main className={styles.page}>
        <div className={styles.unavailable}>
          <h1 className={styles.unavailableTitle}>Registry temporarily unavailable</h1>
          <p className={styles.unavailableBody}>
            We couldn&apos;t load this registry record right now. Please try again in a few
            minutes.
          </p>
        </div>
      </main>
    );
  }

  const { data } = result;
  const displayTitle = data.title ?? data.cc_id;
  const ownerName = data.current_owner?.display_name ?? data.current_owner?.username ?? null;
  const ownerUsername = data.current_owner?.username ?? null;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p className={styles.brand}>CacheCase Registry</p>
        <p className={styles.status}>Registry record found</p>
      </header>

      <section className={styles.identityCard}>
        <div className={styles.imageWrap}>
          {/* Proxied through this site's own /image route rather than
              passing data.snapshot_image_url directly — that signed URL's
              path is registered_cards.id (an internal UUID), which must
              never appear in this page's HTML. See
              app/registry/[ccId]/image/route.ts. */}
          <SnapshotImage
            src={data.snapshot_image_url ? `/registry/${data.cc_id}/image` : null}
            alt={displayTitle}
          />
        </div>
        <div className={styles.identityText}>
          <p className={styles.ccId}>{data.cc_id}</p>
          {data.title && <h1 className={styles.title}>{data.title}</h1>}
          {data.subtitle && <p className={styles.subtitle}>{data.subtitle}</p>}
          {!data.title && !data.subtitle && (
            <h1 className={styles.title}>Registered Card</h1>
          )}
        </div>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Ownership</h2>
        {ownerName ? (
          <p className={styles.ownerLine}>
            <span className={styles.ownerName}>{ownerName}</span>
            {ownerUsername && ownerUsername !== ownerName && (
              <span className={styles.ownerUsername}> @{ownerUsername}</span>
            )}
          </p>
        ) : (
          <p className={styles.mutedLine}>Owner information unavailable.</p>
        )}
        <div className={styles.custodyRow}>
          <span className={styles.custodyLabel}>Custody Status</span>
          <CustodyBadge status={data.custody_status} />
        </div>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Summary</h2>
        <dl className={styles.summaryGrid}>
          <div className={styles.summaryItem}>
            <dt className={styles.summaryLabel}>Registered</dt>
            <dd className={styles.summaryValue}>{formatDate(data.registered_at)}</dd>
          </div>
          <div className={styles.summaryItem}>
            <dt className={styles.summaryLabel}>Ownership Transfers</dt>
            <dd className={styles.summaryValue}>{data.ownership_transfer_count}</dd>
          </div>
          <div className={styles.summaryItem}>
            <dt className={styles.summaryLabel}>Custody Status</dt>
            <dd className={styles.summaryValue}>{formatCustodyStatus(data.custody_status)}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Public Timeline</h2>
        <RegistryTimeline events={data.events} />
      </section>

      <section className={styles.panel}>
        <AppActions />
      </section>
    </main>
  );
}
