import type { GrailChooserTarget } from '@/types';

// expo-router's useLocalSearchParams types every param as
// string | string[] | undefined (a param can theoretically arrive
// duplicated in a URL, e.g. ?mode=add&mode=replace). This is the one
// screen family whose params gate a real database write, so array-shaped
// input is treated as invalid rather than silently taking the first/last
// value.
type RawParam = string | string[] | undefined;

function singleParam(value: RawParam): string | null {
  return typeof value === 'string' ? value : null;
}

function nonEmpty(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type RawGrailChooserParams = {
  slotIndex?: RawParam;
  mode?: RawParam;
  expectedSlotId?: RawParam;
  expectedEntryType?: RawParam;
  expectedRefId?: RawParam;
};

// The one place that trusts nothing about the raw route params a picker
// screen receives — every field is validated (shape, type, range,
// emptiness) before any query or write is attempted. Returns null for
// any invalid combination; callers show "Invalid Grail Slot," make no
// database call, and navigate back rather than guessing at a fallback
// interpretation.
export function parseGrailChooserParams(params: RawGrailChooserParams): GrailChooserTarget | null {
  const slotIndexRaw = nonEmpty(singleParam(params.slotIndex));
  if (slotIndexRaw === null) return null;
  const slotIndex = Number(slotIndexRaw);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 8) return null;

  const mode = singleParam(params.mode);

  if (mode === 'add') {
    // Ignores expectedSlotId/expectedEntryType/expectedRefId even if
    // present (e.g. stale params left over in the URL from a prior
    // navigation) — an add target is fully described by slotIndex alone.
    return { mode: 'add', slotIndex };
  }

  if (mode === 'replace') {
    const expectedSlotId = nonEmpty(singleParam(params.expectedSlotId));
    if (!expectedSlotId) return null;

    const expectedEntryType = singleParam(params.expectedEntryType);
    if (expectedEntryType !== 'item' && expectedEntryType !== 'collection') return null;

    const expectedRefId = nonEmpty(singleParam(params.expectedRefId));
    if (!expectedRefId) return null;

    return {
      mode: 'replace',
      slotIndex,
      expectedSlotId,
      expectedEntryType,
      expectedRefId,
    };
  }

  return null;
}
