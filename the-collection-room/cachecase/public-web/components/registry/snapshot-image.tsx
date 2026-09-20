'use client';

import { useState } from 'react';
import styles from './snapshot-image.module.css';

// Plain <img>, not next/image: the signed URL from get-public-registry-card
// is only valid for 5 minutes. Since this page is rendered fresh per
// request (no caching — see lib/registry-api.ts), the URL is always fresh
// at load time, but next/image's own optimized-variant cache could persist
// a proxied copy past that window and serve a broken image on a later,
// unrelated request. A plain tag sidesteps that entirely and needs no
// remotePatterns config tying this project to one Supabase project's host.
export function SnapshotImage({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className={styles.placeholder} role="img" aria-label={alt}>
        <span className={styles.placeholderMark}>CC</span>
      </div>
    );
  }

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={styles.image} onError={() => setFailed(true)} />;
}
