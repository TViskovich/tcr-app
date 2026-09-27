import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import type { FolderShareItem } from '@/lib/folder-share-post';
import { COMPACT_IMAGE_TIER } from '@/lib/image-tiers';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';

type Props = {
  items: FolderShareItem[];
  // Total eligible items in the folder when it was shared — drives the "+N"
  // on the last cell when more exist than are shown.
  totalCount: number;
  // The folder's explicit cover: a published post's snapshotted cover URL, or
  // (composer preview only) the live signed cover. When present it fills the
  // shell (cover) instead of the item collage.
  coverUrl?: string | null;
  liveCoverUri?: string | null;
  radius?: number;
};

const GAP = 2;

// Preview-size variant of a public share-snapshots object via Supabase's
// image renderer (same 500px/q80 as the preview tier). Anything that isn't a
// recognizable public snapshot URL is used as-is.
const PUBLIC_OBJECT_SEGMENT = '/storage/v1/object/public/share-snapshots/';
function snapshotPreviewUrl(url: string, width = 500): string {
  if (!url.includes(PUBLIC_OBJECT_SEGMENT)) return url;
  return `${url.replace(PUBLIC_OBJECT_SEGMENT, '/storage/v1/render/image/public/share-snapshots/')}?width=${width}&quality=80&resize=contain`;
}

// Square collage of a shared folder's first items (feed + post detail +
// composer preview all render this same component, so they match). 1 item
// fills the frame; 2 items sit side by side; 3 items are one large tile plus
// two stacked; 4 are a 2x2 grid. Images are the preview tier through the
// normal signed-image path (never originals); each cell is a plain dark fill
// until its URL resolves.
export function FolderShareCollage({ items, totalCount, coverUrl, liveCoverUri, radius = 11 }: Props) {
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';
  const shown = items.slice(0, 4);
  // Published posts render their durable share-snapshots copy (no signing);
  // only the composer preview — items with no snapshot yet — goes through the
  // signed preview-tier path.
  const { urls, servedTiers } = useSignedItemImages(
    shown.map((i) => (i.imageUrl ? null : i.primary_image_id)),
    COMPACT_IMAGE_TIER,
  );
  // Snapshot URLs whose resized (preview-size) variant failed to load fall
  // back to the original snapshot URL.
  const [fullSizeIds, setFullSizeIds] = useState<Set<string>>(new Set());
  const [coverFullSize, setCoverFullSize] = useState(false);
  const extra = Math.max(0, totalCount - shown.length);

  function cell(item: FolderShareItem | undefined, style: object, overlayCount = 0) {
    if (!item) return <View style={[styles.cell, style]} />;
    const imageId = item.primary_image_id;
    let source: { uri: string; cacheKey?: string } | null = null;
    if (item.imageUrl) {
      source = fullSizeIds.has(item.id)
        ? { uri: item.imageUrl }
        : { uri: snapshotPreviewUrl(item.imageUrl), cacheKey: `snapshot-preview:${item.imageUrl}` };
    } else if (imageId && urls.get(imageId)) {
      source = {
        uri: urls.get(imageId)!,
        cacheKey: itemImageCacheKey(identity, imageId, COMPACT_IMAGE_TIER, servedTiers),
      };
    }
    return (
      <View key={item.id} style={[styles.cell, style]}>
        {source ? (
          <Image
            source={source}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
            cachePolicy="memory-disk"
            onError={() => {
              if (item.imageUrl && !fullSizeIds.has(item.id)) {
                setFullSizeIds((prev) => new Set(prev).add(item.id));
              }
            }}
          />
        ) : null}
        {overlayCount > 0 && (
          <View style={styles.moreScrim}>
            <Text style={styles.moreText}>+{overlayCount}</Text>
          </View>
        )}
      </View>
    );
  }

  // Cover -> fills the media shell edge to edge (cropped as needed, no
  // letterbox bars), at a preview-size variant (falls back to the original).
  if (coverUrl || liveCoverUri) {
    const coverSource = coverUrl
      ? { uri: coverFullSize ? coverUrl : snapshotPreviewUrl(coverUrl, 900), cacheKey: `snapshot-cover:${coverFullSize ? 'full' : 'preview'}:${coverUrl}` }
      : { uri: liveCoverUri! };
    return (
      <View style={[styles.coverFrame, { borderRadius: radius }]}>
        <Image
          source={coverSource}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          // Bias the crop toward the top of the cover (show more of its top half).
          contentPosition={{ top: '20%', left: '50%' }}
          transition={150}
          cachePolicy="memory-disk"
          onError={() => {
            if (coverUrl && !coverFullSize) setCoverFullSize(true);
          }}
        />
      </View>
    );
  }

  let body;
  if (shown.length <= 1) {
    body = cell(shown[0], styles.fill);
  } else if (shown.length === 2) {
    body = (
      <View style={styles.row}>
        {cell(shown[0], styles.flex)}
        {cell(shown[1], styles.flex)}
      </View>
    );
  } else if (shown.length === 3) {
    body = (
      <View style={styles.row}>
        {cell(shown[0], styles.flex)}
        <View style={[styles.column, styles.flex]}>
          {cell(shown[1], styles.flex)}
          {cell(shown[2], styles.flex, extra)}
        </View>
      </View>
    );
  } else {
    body = (
      <View style={styles.column}>
        <View style={[styles.row, styles.flex]}>
          {cell(shown[0], styles.flex)}
          {cell(shown[1], styles.flex)}
        </View>
        <View style={[styles.row, styles.flex]}>
          {cell(shown[2], styles.flex)}
          {cell(shown[3], styles.flex, extra)}
        </View>
      </View>
    );
  }

  return <View style={[styles.frame, { borderRadius: radius }]}>{body}</View>;
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    aspectRatio: 1,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  // Cover mode: 4:3 shell (a square is too tall for wide covers); the cover
  // fills it.
  coverFrame: {
    width: '100%',
    aspectRatio: 4 / 3,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  row: { flex: 1, flexDirection: 'row', gap: GAP },
  column: { flex: 1, gap: GAP },
  flex: { flex: 1 },
  fill: { flex: 1 },
  cell: { overflow: 'hidden', backgroundColor: PV2.collectorPanelBg },
  moreScrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreText: { color: '#fff', fontSize: 20, fontWeight: '700' },
});
