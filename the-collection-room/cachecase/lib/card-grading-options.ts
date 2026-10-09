// Grading Company choices for the Sports Card and Pokémon item forms
// (app/item/new.tsx / app/item/[id].tsx), shared so Add and Edit render
// identical lists. Plain strings saved as-is to the existing grading_company
// columns (collection_items / pokemon_card_details) — same convention as
// lib/comic-book-options.ts. The "-" (none) choice is added by
// GradingCompanyField, not listed here.

export const SPORTS_CARD_GRADING_COMPANIES = ['PSA', 'BGS', 'SGC', 'CGC', 'TAG', 'Arena Club', 'Other'];

export const POKEMON_GRADING_COMPANIES = ['PSA', 'BGS', 'CGC', 'TAG', 'ACE', 'Other'];
