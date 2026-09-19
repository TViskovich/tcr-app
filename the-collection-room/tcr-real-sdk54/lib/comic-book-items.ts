import { supabase } from './supabase';
import type { ComicBookDetails, ComicConditionType, CollectionItem } from '@/types';

// Thin wrappers around the atomic create_comic_book_item/update_comic_book_item
// RPCs (supabase/migrations/20260917130100_create_comic_book_item_rpcs.sql) —
// both write collection_items and comic_book_details together in one
// transaction, so callers never have to hand-roll a two-table write or a
// rollback path themselves. Mirrors lib/pokemon-items.ts exactly.

export type ComicBookItemFields = {
  estimatedValue: number | null;
  description: string | null;
  isPublic: boolean;
  seriesTitle: string | null;
  issueNumber: string | null;
  publisher: string | null;
  publicationYear: number | null;
  volume: string | null;
  coverVariant: string | null;
  printing: string | null;
  conditionType: ComicConditionType;
  condition: string | null;
  gradingCompany: string | null;
  grade: string | null;
  certificationNumber: string | null;
  labelType: string | null;
  pageQuality: string | null;
  isKeyIssue: boolean;
  keyTypes: string[];
  keyDescription: string | null;
  characters: string | null;
  storyArc: string | null;
  writer: string | null;
  interiorArtist: string | null;
  coverArtist: string | null;
  edition: string | null;
  variantName: string | null;
  variantArtist: string | null;
  incentiveRatio: string | null;
  retailerExclusive: string | null;
  specialCoverFinish: string | null;
  countryMarket: string | null;
  isSigned: boolean;
  signedBy: string | null;
  signatureAuthentication: string | null;
  isRestored: boolean;
  restorationNotes: string | null;
};

// Both RPCs return the single created/updated collection_items row — same
// shape createPokemonItem/updatePokemonItem already use.
export async function createComicBookItem(
  folderId: string,
  fields: ComicBookItemFields,
): Promise<CollectionItem> {
  const { data, error } = await supabase.rpc('create_comic_book_item', {
    p_folder_id: folderId,
    p_estimated_value: fields.estimatedValue,
    p_description: fields.description,
    p_is_public: fields.isPublic,
    p_series_title: fields.seriesTitle,
    p_issue_number: fields.issueNumber,
    p_publisher: fields.publisher,
    p_publication_year: fields.publicationYear,
    p_volume: fields.volume,
    p_cover_variant: fields.coverVariant,
    p_printing: fields.printing,
    p_condition_type: fields.conditionType,
    p_condition: fields.condition,
    p_grading_company: fields.gradingCompany,
    p_grade: fields.grade,
    p_certification_number: fields.certificationNumber,
    p_label_type: fields.labelType,
    p_page_quality: fields.pageQuality,
    p_is_key_issue: fields.isKeyIssue,
    p_key_types: fields.keyTypes,
    p_key_description: fields.keyDescription,
    p_characters: fields.characters,
    p_story_arc: fields.storyArc,
    p_writer: fields.writer,
    p_interior_artist: fields.interiorArtist,
    p_cover_artist: fields.coverArtist,
    p_edition: fields.edition,
    p_variant_name: fields.variantName,
    p_variant_artist: fields.variantArtist,
    p_incentive_ratio: fields.incentiveRatio,
    p_retailer_exclusive: fields.retailerExclusive,
    p_special_cover_finish: fields.specialCoverFinish,
    p_country_market: fields.countryMarket,
    p_is_signed: fields.isSigned,
    p_signed_by: fields.signedBy,
    p_signature_authentication: fields.signatureAuthentication,
    p_is_restored: fields.isRestored,
    p_restoration_notes: fields.restorationNotes,
  });
  if (error) throw new Error(error.message);
  return data as CollectionItem;
}

export async function updateComicBookItem(
  itemId: string,
  fields: ComicBookItemFields,
): Promise<CollectionItem> {
  const { data, error } = await supabase.rpc('update_comic_book_item', {
    p_item_id: itemId,
    p_estimated_value: fields.estimatedValue,
    p_description: fields.description,
    p_is_public: fields.isPublic,
    p_series_title: fields.seriesTitle,
    p_issue_number: fields.issueNumber,
    p_publisher: fields.publisher,
    p_publication_year: fields.publicationYear,
    p_volume: fields.volume,
    p_cover_variant: fields.coverVariant,
    p_printing: fields.printing,
    p_condition_type: fields.conditionType,
    p_condition: fields.condition,
    p_grading_company: fields.gradingCompany,
    p_grade: fields.grade,
    p_certification_number: fields.certificationNumber,
    p_label_type: fields.labelType,
    p_page_quality: fields.pageQuality,
    p_is_key_issue: fields.isKeyIssue,
    p_key_types: fields.keyTypes,
    p_key_description: fields.keyDescription,
    p_characters: fields.characters,
    p_story_arc: fields.storyArc,
    p_writer: fields.writer,
    p_interior_artist: fields.interiorArtist,
    p_cover_artist: fields.coverArtist,
    p_edition: fields.edition,
    p_variant_name: fields.variantName,
    p_variant_artist: fields.variantArtist,
    p_incentive_ratio: fields.incentiveRatio,
    p_retailer_exclusive: fields.retailerExclusive,
    p_special_cover_finish: fields.specialCoverFinish,
    p_country_market: fields.countryMarket,
    p_is_signed: fields.isSigned,
    p_signed_by: fields.signedBy,
    p_signature_authentication: fields.signatureAuthentication,
    p_is_restored: fields.isRestored,
    p_restoration_notes: fields.restorationNotes,
  });
  if (error) throw new Error(error.message);
  return data as CollectionItem;
}

// Read-only — plain select under comic_book_details_select_public, same
// visibility rule as the parent item (see that policy's own comment).
// Returns null both when the item has no detail row yet and when the query
// itself is denied by RLS; callers never need to tell those apart.
export async function getComicBookDetails(itemId: string): Promise<ComicBookDetails | null> {
  const { data, error } = await supabase
    .from('comic_book_details')
    .select('*')
    .eq('item_id', itemId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ComicBookDetails | null) ?? null;
}
