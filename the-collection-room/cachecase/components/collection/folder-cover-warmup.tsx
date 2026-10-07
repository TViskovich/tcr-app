import { PrivateImageWarmup, type WarmupEntry } from '@/components/images/private-image-warmup';
import { FOLDER_HEADER_COVER_TIER, useSignedFolderCovers } from '@/hooks/use-signed-folder-covers';
import { COMPACT_IMAGE_TIER } from '@/lib/image-tiers';
import type { Folder } from '@/types';

// Conservative, fixed limits — there is no app-wide bandwidth policy to
// defer to. The first few folders in the list's own render order (no
// viewability tracking exists on these lists, so first-N stands in for
// "visible / most likely tapped").
const PREVIEW_WARMUP_COUNT = 6;
const DETAIL_WARMUP_COUNT = 3;

type Props = {
  // In the order the list renders them.
  folders: Folder[];
};

// Hides folder-cover cold-load latency while the user is still browsing a
// collection list: signs, then downloads in the background, the covers of
// the first few folders before any is tapped, so opening one finds its
// header cover already in cache.
//
// Mount this only once the Collection list is actually active (the screen
// or tab is opened) — it starts its work on mount. It is idempotent: every
// piece goes through the existing shared machinery, so anything already
// cached (memory, persisted signed URL, or image bytes) or in flight is
// skipped, and leaving and returning to the list re-warms only what's
// missing or stale.
//   - Signing: useSignedFolderCovers, i.e. the existing authorized
//     get-folder-cover-signed-url function — one batched call per tier,
//     identity-scoped cache, shared in-flight map. The detail tier is
//     FOLDER_HEADER_COVER_TIER, the exact cache entry the folder header
//     (and prefetchFolderHeaderCover's tap-time prefetch) reads, so a tap or
//     the destination screen mid-warmup joins this request rather than
//     issuing another.
//   - Bytes: PrivateImageWarmup with each cover's stable cacheKey (token-
//     backed for first_card covers). It skips any entry without a stable
//     key, so a cover with no URL (no-cover folder / unauthorized) or no
//     stable identity yet never downloads anything here.
// Never nested child folders, never the original tier.
export function FolderCoverWarmup({ folders }: Props) {
  const previewFolders = folders.slice(0, PREVIEW_WARMUP_COUNT);
  const detailFolders = folders.slice(0, DETAIL_WARMUP_COUNT);

  const preview = useSignedFolderCovers(
    previewFolders.map((f) => f.id),
    COMPACT_IMAGE_TIER,
  );
  const detail = useSignedFolderCovers(
    detailFolders.map((f) => f.id),
    FOLDER_HEADER_COVER_TIER,
  );

  const entries: WarmupEntry[] = [];
  for (const folder of previewFolders) {
    const source = preview.coverSource(folder);
    if (source) entries.push({ id: `preview-${folder.id}`, uri: source.uri, cacheKey: source.cacheKey });
  }
  for (const folder of detailFolders) {
    const source = detail.coverSource(folder);
    if (source) entries.push({ id: `detail-${folder.id}`, uri: source.uri, cacheKey: source.cacheKey });
  }

  return <PrivateImageWarmup entries={entries} />;
}
