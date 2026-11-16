// When an item's legacy collection_items.image_url may be turned into a real
// gallery row on entering edit mode (P2.3, review F2). Pure, unit tested:
// node --test lib/legacy-item-image.test.ts
//
// Only from AUTHORITATIVE server state, never from screen state: after the
// owner removes the last photo the server clears image_url, but a stale
// screen could still hold the old URL — re-creating a row from it would
// cancel the photo's deletion (the "removed" photo comes back) or, once the
// file is gone, leave a broken gallery row. The database also refuses any
// reference to a photo whose deletion has started.
export function shouldMaterializeLegacyImage(input: {
  serverGalleryCount: number | null | undefined;
  serverImageUrl: string | null | undefined;
}): boolean {
  return input.serverGalleryCount === 0 && typeof input.serverImageUrl === 'string' && input.serverImageUrl.length > 0;
}
