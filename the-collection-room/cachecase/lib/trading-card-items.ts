import { supabase } from './supabase';
import type { CollectionItem } from '@/types';

// Thin wrappers around the atomic create_trading_card_item/
// update_trading_card_item RPCs (supabase/migrations/
// 20261017120000_add_trading_card_items.sql) — both write collection_items
// and trading_card_details together in one transaction. Same shape as
// lib/pokemon-items.ts.

export type TradingCardItemFields = {
  estimatedValue: number | null;
  description: string | null;
  isPublic: boolean;
  franchise: string | null;
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  rarity: string | null;
  language: string | null;
  edition: string | null;
  gradingCompany: string | null;
  grade: string | null;
};

function rpcArgs(fields: TradingCardItemFields) {
  return {
    p_estimated_value: fields.estimatedValue,
    p_description: fields.description,
    p_is_public: fields.isPublic,
    p_franchise: fields.franchise,
    p_card_name: fields.cardName,
    p_set_name: fields.setName,
    p_card_number: fields.cardNumber,
    p_rarity: fields.rarity,
    p_language: fields.language,
    p_edition: fields.edition,
    p_grading_company: fields.gradingCompany,
    p_grade: fields.grade,
  };
}

export async function createTradingCardItem(folderId: string, fields: TradingCardItemFields): Promise<CollectionItem> {
  const { data, error } = await supabase.rpc('create_trading_card_item', { p_folder_id: folderId, ...rpcArgs(fields) });
  if (error) throw new Error(error.message);
  return data as CollectionItem;
}

export async function updateTradingCardItem(itemId: string, fields: TradingCardItemFields): Promise<CollectionItem> {
  const { data, error } = await supabase.rpc('update_trading_card_item', { p_item_id: itemId, ...rpcArgs(fields) });
  if (error) throw new Error(error.message);
  return data as CollectionItem;
}
