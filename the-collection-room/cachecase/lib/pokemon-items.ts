import { supabase } from './supabase';
import type { CollectionItem, PokemonCardDetails } from '@/types';

// Thin wrappers around the atomic create_pokemon_item/update_pokemon_item
// RPCs (supabase/migrations/20260917120100_create_pokemon_item_rpcs.sql) —
// both write collection_items and pokemon_card_details together in one
// transaction, so callers never have to hand-roll a two-table write or a
// rollback path themselves. Mirrors lib/item-images.ts's own
// "one small file per feature area" convention rather than growing
// item-images.ts or the screens themselves.

export type PokemonItemFields = {
  estimatedValue: number | null;
  description: string | null;
  isPublic: boolean;
  pokemonName: string | null;
  setName: string | null;
  cardNumber: string | null;
  rarity: string | null;
  language: string | null;
  edition: string | null;
  holoType: string | null;
  gradingCompany: string | null;
  grade: string | null;
};

// Both RPCs return the single created/updated collection_items row — same
// "RETURNS public.<table>, caller gets a plain object back from
// supabase.rpc()" shape register_card already uses (see
// hooks/use-registered-card.ts's own `data as RegisteredCard`).
export async function createPokemonItem(
  folderId: string,
  fields: PokemonItemFields,
): Promise<CollectionItem> {
  const { data, error } = await supabase.rpc('create_pokemon_item', {
    p_folder_id: folderId,
    p_estimated_value: fields.estimatedValue,
    p_description: fields.description,
    p_is_public: fields.isPublic,
    p_pokemon_name: fields.pokemonName,
    p_set_name: fields.setName,
    p_card_number: fields.cardNumber,
    p_rarity: fields.rarity,
    p_language: fields.language,
    p_edition: fields.edition,
    p_holo_type: fields.holoType,
    p_grading_company: fields.gradingCompany,
    p_grade: fields.grade,
  });
  if (error) throw new Error(error.message);
  return data as CollectionItem;
}

export async function updatePokemonItem(
  itemId: string,
  fields: PokemonItemFields,
): Promise<CollectionItem> {
  const { data, error } = await supabase.rpc('update_pokemon_item', {
    p_item_id: itemId,
    p_estimated_value: fields.estimatedValue,
    p_description: fields.description,
    p_is_public: fields.isPublic,
    p_pokemon_name: fields.pokemonName,
    p_set_name: fields.setName,
    p_card_number: fields.cardNumber,
    p_rarity: fields.rarity,
    p_language: fields.language,
    p_edition: fields.edition,
    p_holo_type: fields.holoType,
    p_grading_company: fields.gradingCompany,
    p_grade: fields.grade,
  });
  if (error) throw new Error(error.message);
  return data as CollectionItem;
}

// Read-only — plain select under pokemon_card_details_select_public, same
// visibility rule as the parent item (see that policy's own comment).
// Returns null both when the item has no detail row yet and when the query
// itself is denied by RLS; callers never need to tell those apart.
export async function getPokemonCardDetails(itemId: string): Promise<PokemonCardDetails | null> {
  const { data, error } = await supabase
    .from('pokemon_card_details')
    .select('*')
    .eq('item_id', itemId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PokemonCardDetails | null) ?? null;
}
