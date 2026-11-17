// Grails image download order (pre-build-23 image performance). Pure (no
// React Native imports) so it is unit tested:
//   node --test lib/grail-image-priority.test.ts
//
// The profile Grails grid signs every slot image in ONE batched request
// (components/profile-v2/profile-v2-grid.tsx) — unchanged here, so no extra
// request is ever made for ordering. What this decides is the order the
// already-signed bytes are WARMED in:
//   * first frame — the image each occupied slot shows first: an item
//     slot's primary image, a collection slot's first preview that actually
//     has a signed URL (exactly what GrailSlotPreview starts its rotation
//     on: the first usable preview);
//   * secondary — every other collection preview, needed only later by the
//     rotation.
// Before, all of them were warmed at once at the same priority, so a later
// slot's first image could queue behind an earlier collection slot's
// rotation previews (24 downloads competing for a 9-image first frame).

export type GrailSlotImages = {
  entry_type: 'item' | 'collection';
  item?: { primary_image_id?: string | null } | null;
  previewImageIds?: string[] | null;
};

export type GrailImagePlan = {
  // In slot order, de-duplicated.
  firstFrame: string[];
  // In slot then rotation order, de-duplicated, never repeating a first-frame id.
  secondary: string[];
};

// hasUrl: whether the signing batch returned a URL for an id (an
// unavailable image never becomes a collection slot's first frame, matching
// the visible slot, which skips it).
export function grailImagePlan(slots: GrailSlotImages[], hasUrl: (imageId: string) => boolean): GrailImagePlan {
  const firstFrame: string[] = [];
  const seen = new Set<string>();
  const add = (list: string[], id: string | null | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    list.push(id);
  };
  for (const slot of slots) {
    if (slot.entry_type === 'item') add(firstFrame, slot.item?.primary_image_id);
    else add(firstFrame, (slot.previewImageIds ?? []).find((id) => hasUrl(id)));
  }
  const secondary: string[] = [];
  for (const slot of slots) {
    if (slot.entry_type !== 'collection') continue;
    for (const id of slot.previewImageIds ?? []) add(secondary, id);
  }
  return { firstFrame, secondary };
}

// Whether the secondary (rotation) previews may start warming: once every
// first-frame image that HAS a signed URL has finished (loaded or failed).
// First-frame ids still waiting for their URL don't hold the rotation back —
// they can't be downloaded yet anyway.
export function secondaryWarmupReady(
  firstFrame: string[],
  hasUrl: (imageId: string) => boolean,
  settled: ReadonlySet<string>,
): boolean {
  return firstFrame.every((id) => !hasUrl(id) || settled.has(id));
}
