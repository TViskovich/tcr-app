import { supabase } from './supabase';
import type { MetadataRow } from '@/components/item-detail/item-metadata-section';
import type {
  CollectionItem,
  CollectionItemPrivateDetails,
  OtherItemCategory,
  OtherItemDetails,
  OtherItemDetailValue,
} from '@/types';

// The "Other" collectible type (supabase/migrations/
// 20261024120000_add_other_item_details.sql): one shared other_item_details
// row per item — a fixed category, an optional search_identifier, and a
// jsonb details object the database validates against the category's spec
// (other_item_details_spec) — plus the owner-only
// collection_item_private_details row for the purchase price. Thin wrappers
// around the atomic create_other_item/update_other_item RPCs, same shape as
// lib/trading-card-items.ts, plus the shared pieces every category's adapter
// (lib/other-item-*.ts) uses.

// Add Item's Category labels (lib/other-category-options.ts) ↔ slugs.
// 'custom' is a collector-named category ("Other" + their own text).
export const OTHER_CATEGORY_LABELS: Record<OtherItemCategory, string> = {
  sneakers: 'Sneakers',
  watches: 'Watches',
  art_prints: 'Art & Prints',
  toys: 'Toys',
  books: 'Books',
  pins: 'Pins',
  custom: 'Other',
};

export const CUSTOM_CATEGORY_NAME_MAX = 60;

// The Category dropdown's value → slug. '' (unset) and the bare word
// "Other" (picked, nothing typed yet) are null; any other unlisted text is
// a custom category.
export function otherCategoryFromOption(option: string): OtherItemCategory | null {
  const value = option.trim();
  if (!value || value.toLowerCase() === 'other') return null;
  const listed = (Object.keys(OTHER_CATEGORY_LABELS) as OtherItemCategory[]).find(
    (category) => category !== 'custom' && OTHER_CATEGORY_LABELS[category].toLowerCase() === value.toLowerCase(),
  );
  return listed ?? 'custom';
}

export function otherCategoryDisplayName(details: Pick<OtherItemDetails, 'category' | 'custom_category_name'>): string {
  if (details.category === 'custom') return details.custom_category_name?.trim() || OTHER_CATEGORY_LABELS.custom;
  return OTHER_CATEGORY_LABELS[details.category] ?? OTHER_CATEGORY_LABELS.custom;
}

// ── RPCs ─────────────────────────────────────────────────────────────────

export type OtherItemDetailsPayload = Record<string, OtherItemDetailValue>;

// Shared columns live on collection_items (title is the category's primary
// identifying field — the only required one); details holds the rest;
// purchasePrice is private (owner-only table).
export type OtherItemFields = {
  title: string;
  customCategoryName: string | null;
  brand: string | null;
  year: number | null;
  estimatedValue: number | null;
  description: string | null;
  isPublic: boolean;
  searchIdentifier: string | null;
  details: OtherItemDetailsPayload;
  purchasePrice: number | null;
};

function rpcArgs(fields: OtherItemFields) {
  return {
    p_title: fields.title,
    p_custom_category_name: fields.customCategoryName,
    p_brand: fields.brand,
    p_year: fields.year,
    p_estimated_value: fields.estimatedValue,
    p_description: fields.description,
    p_is_public: fields.isPublic,
    p_search_identifier: fields.searchIdentifier,
    p_details: fields.details,
    p_purchase_price: fields.purchasePrice,
  };
}

export async function createOtherItem(
  folderId: string,
  category: OtherItemCategory,
  fields: OtherItemFields,
): Promise<CollectionItem> {
  const { data, error } = await supabase.rpc('create_other_item', {
    p_folder_id: folderId,
    p_category: category,
    ...rpcArgs(fields),
  });
  if (error) throw new Error(error.message);
  return data as CollectionItem;
}

// Item type and category never change — update_other_item has no category
// parameter. Every field is written as sent, so the caller must send the
// complete current state (including purchasePrice — null clears it).
export async function updateOtherItem(itemId: string, fields: OtherItemFields): Promise<CollectionItem> {
  const { data, error } = await supabase.rpc('update_other_item', { p_item_id: itemId, ...rpcArgs(fields) });
  if (error) throw new Error(error.message);
  return data as CollectionItem;
}

// An Other item's details row, fetched on its own (only for 'other' items)
// rather than embedded in Item Detail's main select, so that select never
// depends on this table existing. null = no row visible.
export async function fetchOtherItemDetails(itemId: string): Promise<OtherItemDetails | null> {
  const { data, error } = await supabase.from('other_item_details').select('*').eq('item_id', itemId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as OtherItemDetails | null) ?? null;
}

// The owner's private row. RLS returns nothing to anyone else, so callers
// only ask for it as the owner. null = nothing set.
export async function fetchItemPrivateDetails(itemId: string): Promise<CollectionItemPrivateDetails | null> {
  const { data, error } = await supabase
    .from('collection_item_private_details')
    .select('item_id, purchase_price')
    .eq('item_id', itemId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as { item_id: string; purchase_price: number | string | null };
  return { item_id: row.item_id, purchase_price: row.purchase_price != null ? Number(row.purchase_price) : null };
}

// ── Category adapters ────────────────────────────────────────────────────
// One per category: maps that category's existing form state to the RPC
// fields and back, validates it the same way the database will, and builds
// Item Detail's identity and metadata rows. privateDetails is null for
// everyone but the owner (and for an owner with nothing set).

export type OtherFormIssue = { title: string; message: string };

export type OtherItemIdentity = { title: string; subtitleLines: (string | null)[] };

export type OtherCategoryAdapter<Form> = {
  category: OtherItemCategory;
  initialForm: Form;
  validate: (form: Form) => OtherFormIssue | null;
  // Everything but isPublic / customCategoryName, which the screen owns.
  toFields: (form: Form) => Omit<OtherItemFields, 'isPublic' | 'customCategoryName'>;
  fromItem: (
    item: CollectionItem,
    details: OtherItemDetails | null,
    privateDetails: CollectionItemPrivateDetails | null,
  ) => Form;
  identity: (item: CollectionItem, details: OtherItemDetails | null) => OtherItemIdentity;
  metadataRows: (
    item: CollectionItem,
    details: OtherItemDetails | null,
    privateDetails: CollectionItemPrivateDetails | null,
  ) => MetadataRow[];
};

// ── Shared form helpers ──────────────────────────────────────────────────

export const OTHER_YEAR_MIN = 1000;
export const OTHER_YEAR_MAX = 2100;
export const SEARCH_IDENTIFIER_MAX = 100;
const MONEY_MAX = 9_999_999_999.99;

export function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// The first issue found, or null.
export function firstIssue(...issues: (OtherFormIssue | null)[]): OtherFormIssue | null {
  return issues.find((issue) => issue != null) ?? null;
}

export function requiredText(value: string, label: string, message: string): OtherFormIssue | null {
  return value.trim() ? null : { title: `${label} required`, message };
}

// An "Other" dropdown left on the bare word "Other" (nothing typed) — the
// database never stores it.
export function unspecifiedOption(value: string, label: string): OtherFormIssue | null {
  return value.trim().toLowerCase() === 'other'
    ? { title: `${label} required`, message: `Please specify the ${label.toLowerCase()}, or choose one from the list.` }
    : null;
}

export function textTooLong(value: string, max: number, label: string): OtherFormIssue | null {
  return value.trim().length > max
    ? { title: `${label} too long`, message: `${label} can be at most ${max} characters.` }
    : null;
}

type Parsed = { value: number | null; issue: OtherFormIssue | null };

// '' → null. A non-empty value must be a 4-digit year in range.
export function parseOptionalYear(value: string, label: string): Parsed {
  const trimmed = value.trim();
  if (!trimmed) return { value: null, issue: null };
  const year = /^\d{4}$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
  if (Number.isNaN(year) || year < OTHER_YEAR_MIN || year > OTHER_YEAR_MAX) {
    return {
      value: null,
      issue: { title: `Check ${label}`, message: `${label} must be a year between ${OTHER_YEAR_MIN} and ${OTHER_YEAR_MAX}.` },
    };
  }
  return { value: year, issue: null };
}

// '' → null. Accepts "120", "120.5", "1,200.00", "$120"; at most two
// decimals, never negative (the database's money rule).
export function parseOptionalMoney(value: string, label: string): Parsed {
  const cleaned = value.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!cleaned) return { value: null, issue: null };
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned) || parseFloat(cleaned) > MONEY_MAX) {
    return {
      value: null,
      issue: { title: `Check ${label}`, message: `${label} must be an amount like 120 or 120.50.` },
    };
  }
  return { value: parseFloat(cleaned), issue: null };
}

// '' → null. A whole number in [min, max] (the database's integer rule).
export function parseOptionalInteger(value: string, label: string, min = 1, max = 1_000_000): Parsed {
  const trimmed = value.trim().replace(/,/g, '');
  if (!trimmed) return { value: null, issue: null };
  const n = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
  if (Number.isNaN(n) || n < min || n > max) {
    return {
      value: null,
      issue: { title: `Check ${label}`, message: `${label} must be a whole number from ${min} to ${max}.` },
    };
  }
  return { value: n, issue: null };
}

// '' → null. A number in [min, max] with at most two decimals (the
// database's number rule). A decimal comma is accepted ("41,5").
export function parseOptionalDecimal(value: string, label: string, min: number, max: number): Parsed {
  const trimmed = value.trim().replace(',', '.');
  if (!trimmed) return { value: null, issue: null };
  const n = /^\d+(\.\d{1,2})?$/.test(trimmed) ? parseFloat(trimmed) : NaN;
  if (Number.isNaN(n) || n < min || n > max) {
    return {
      value: null,
      issue: { title: `Check ${label}`, message: `${label} must be a number from ${min} to ${max}, with at most two decimals.` },
    };
  }
  return { value: n, issue: null };
}

// Builds a details object with only the fields that are set — '' / null /
// [] / false are omitted (the database rejects null and empty values).
export function compactDetails(
  entries: Record<string, OtherItemDetailValue | null | undefined>,
): OtherItemDetailsPayload {
  const out: OtherItemDetailsPayload = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value == null || value === false) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

// Readers for a saved details object — tolerant of missing keys and of a
// value saved with a different type (returns the empty form value).
export function detailText(details: OtherItemDetails | null, key: string): string {
  const value = details?.details?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

export function detailBool(details: OtherItemDetails | null, key: string): boolean {
  return details?.details?.[key] === true;
}

export function detailList(details: OtherItemDetails | null, key: string): string[] {
  const value = details?.details?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function formatMoney(value: number | null | undefined): string | null {
  return value != null ? `$${Number(value).toFixed(2)}` : null;
}

export function yearText(year: number | null | undefined): string {
  return year != null ? String(year) : '';
}

export function moneyText(value: number | null | undefined): string {
  return value != null ? String(value) : '';
}

export function yesOrNull(value: boolean): string | null {
  return value ? 'Yes' : null;
}

// "a of b" / "a/b" display for pair fields; a lone value shows as is.
export function pairLabel(first: string, second: string, separator: string): string | null {
  if (first && second) return `${first}${separator}${second}`;
  return first || second || null;
}

// Shared rows every category ends with: owner-only purchase price, then
// estimated value.
export function valueRows(
  item: CollectionItem,
  privateDetails: CollectionItemPrivateDetails | null,
): MetadataRow[] {
  return [
    { label: 'Purchase Price', value: formatMoney(privateDetails?.purchase_price) },
    { label: 'Estimated Value', value: formatMoney(item.estimated_value) },
  ];
}
