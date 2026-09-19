// Fixed option vocabularies for the Comic Book item form (app/item/new.tsx /
// app/item/[id].tsx) — plain string lists, not TS enums, matching this
// project's existing convention for category-specific text columns (e.g.
// PokemonCardDetails.grading_company/rarity are plain `string | null`, with
// no dedicated union type). Shared in one place so Add and Edit render
// identical choices without copy-pasting six arrays across two screens.
// Mirrors lib/pokemon-items.ts's own "one small file per feature area"
// convention.

export const COMIC_PRINTING_OPTIONS = [
  '1st Print',
  '2nd Print',
  '3rd Print',
  'Later Printing',
  'Facsimile',
  'Other',
];

export const COMIC_RAW_CONDITION_OPTIONS = [
  'Gem Mint',
  'Mint',
  'Near Mint / Mint',
  'Near Mint',
  'Very Fine / Near Mint',
  'Very Fine',
  'Fine',
  'Very Good',
  'Good',
  'Fair',
  'Poor',
  'Other',
];

export const COMIC_GRADING_COMPANY_OPTIONS = ['CGC', 'CBCS', 'PSA', 'Other'];

export const COMIC_KEY_TYPE_OPTIONS = [
  'First Appearance',
  'First Full Appearance',
  'Cameo Appearance',
  'First Cover Appearance',
  'Origin',
  'Death',
  'First Issue',
  'Major Event',
  'New Costume / Identity',
  'Significant Story',
  'Other',
];

export const COMIC_EDITION_OPTIONS = ['Direct', 'Newsstand', 'International', 'Other'];

export const COMIC_SPECIAL_COVER_FINISH_OPTIONS = [
  'Virgin',
  'Foil',
  'Holo',
  'Sketch',
  'Metal',
  'Glow',
  'Other',
];
