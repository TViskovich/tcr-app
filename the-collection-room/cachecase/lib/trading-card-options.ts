// Trading Card (Other) — Card Game / Franchise choices (Add/Edit Item).
// "Other" reveals "Specify franchise"; the typed name is what's stored
// (see components/item-detail/option-with-other-field.tsx). "Other" with
// nothing typed can't be saved (isUnspecifiedFranchise; the database
// functions reject it too).
export const TRADING_CARD_FRANCHISE_OPTIONS = [
  'Magic: The Gathering',
  'Yu-Gi-Oh!',
  'One Piece',
  'Disney Lorcana',
  'Dragon Ball',
  'Digimon',
  'Naruto',
  'Star Wars',
  'Other',
];

export const UNSPECIFIED_FRANCHISE_MESSAGE = 'Please specify the franchise, or choose one from the list.';

// "Other" chosen but no custom franchise typed — the field then holds the
// bare word "Other" (see OptionWithOtherField), which is never saved.
export function isUnspecifiedFranchise(franchise: string): boolean {
  return franchise.trim().toLowerCase() === 'other';
}
