// Pokémon Details dropdown choices (Add Item / Edit Item). Stored as these
// exact strings in pokemon_details; unset is stored as null, shown as "-".
// "Other" lets the collector type their own value (stored as typed). A
// saved value that isn't in a list (older free-text entries) is kept and
// shown as an "Other" custom value — see components/item-detail/
// option-with-other-field.tsx.

export const POKEMON_RARITY_OPTIONS = [
  'Common',
  'Uncommon',
  'Rare',
  'Rare Holo',
  'Double Rare',
  'Ultra Rare',
  'Illustration Rare',
  'Special Illustration Rare',
  'Hyper Rare',
  'ACE SPEC Rare',
  'Shiny Rare',
  'Shiny Ultra Rare',
  'Radiant Rare',
  'Amazing Rare',
  'Promo',
  'Secret Rare (legacy)',
  'Rare Holo EX',
  'Rare Holo GX',
  'Rare Holo Lv.X',
  'Rare Prime',
  'LEGEND',
  'Rare BREAK',
  'Black White Rare',
  'Mega Hyper Rare',
  'Mega Attack Rare',
  'Pikachu Rare',
  'Futuristic Rare',
  'Classic Collection',
  'Other',
];

export const POKEMON_LANGUAGE_OPTIONS = [
  'English',
  'Japanese',
  'Chinese (Simplified)',
  'Chinese (Traditional)',
  'Korean',
  'French',
  'German',
  'Italian',
  'Spanish',
  'Portuguese',
  'Indonesian',
  'Thai',
  'Dutch',
  'Russian',
  'Polish',
  'Other',
];

export const POKEMON_EDITION_OPTIONS = ['1st Edition', 'Shadowless', 'Unlimited', 'Not Applicable', 'Other'];
