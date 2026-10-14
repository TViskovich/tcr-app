import type { Folder, FolderCollectionType } from '@/types';

// Optional descriptive metadata for a Collection (top-level folder) or
// Gallery (nested folder) — see supabase/migrations/
// 20261021120000_add_folder_metadata.sql for the columns and their CHECK
// constraints, which this module's limits mirror. Shared by the Create and
// Edit folder modals (validation) and the folder detail screen (display).

export const FOLDER_DESCRIPTION_MAX = 500;
export const FOLDER_GENRE_MAX = 60;
export const FOLDER_YEAR_MIN = 1860;
export const FOLDER_YEAR_MAX = 2100;

// Display labels, in menu order. Values reuse collection_items.item_type's
// slugs where they overlap (see CollectibleItemType), plus 'mixed'/'other'.
export const FOLDER_COLLECTION_TYPES: { value: FolderCollectionType; label: string }[] = [
  { value: 'sports_card', label: 'Sports Cards' },
  { value: 'pokemon', label: 'Pokémon Cards' },
  { value: 'trading_card', label: 'Trading Cards' },
  { value: 'comic_book', label: 'Comic Books' },
  { value: 'figurine', label: 'Figurines' },
  { value: 'mixed', label: 'Mixed Collectibles' },
  { value: 'other', label: 'Other' },
];

// The Type dropdown's "clear" choice — maps to NULL.
export const FOLDER_TYPE_NONE_LABEL = 'None';

export function folderCollectionTypeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return FOLDER_COLLECTION_TYPES.find((t) => t.value === value)?.label ?? null;
}

export function folderCollectionTypeFromLabel(label: string): FolderCollectionType | null {
  return FOLDER_COLLECTION_TYPES.find((t) => t.label === label)?.value ?? null;
}

// Form state — every field is the raw text the user sees (year included),
// so an untouched field round-trips exactly and clearing one is just ''.
export type FolderMetadataForm = {
  description: string;
  year: string;
  type: FolderCollectionType | null;
  genre: string;
};

export const EMPTY_FOLDER_METADATA_FORM: FolderMetadataForm = { description: '', year: '', type: null, genre: '' };

// Seeds the Edit form from a saved folder. Older cached folder rows may
// predate these columns entirely (undefined), which reads as empty.
export function folderMetadataFormFrom(folder: Folder): FolderMetadataForm {
  return {
    description: folder.description ?? '',
    year: folder.collection_year != null ? String(folder.collection_year) : '',
    type: folder.collection_type ?? null,
    genre: folder.genre ?? '',
  };
}

export type FolderMetadataPatch = {
  description: string | null;
  collection_year: number | null;
  collection_type: FolderCollectionType | null;
  genre: string | null;
};

// Form → columns for an insert/update, or the first problem to show the
// user. Blank (or whitespace-only) optional fields become NULL, which is
// how a cleared field is saved.
export function folderMetadataPatch(
  form: FolderMetadataForm,
): { ok: true; patch: FolderMetadataPatch } | { ok: false; message: string } {
  const description = form.description.trim();
  const genre = form.genre.trim();
  const yearText = form.year.trim();

  let year: number | null = null;
  if (yearText) {
    if (!/^\d{4}$/.test(yearText)) {
      return { ok: false, message: 'Year must be a 4-digit year, or left blank.' };
    }
    year = Number(yearText);
    if (year < FOLDER_YEAR_MIN || year > FOLDER_YEAR_MAX) {
      return { ok: false, message: `Year must be between ${FOLDER_YEAR_MIN} and ${FOLDER_YEAR_MAX}.` };
    }
  }
  if (description.length > FOLDER_DESCRIPTION_MAX) {
    return { ok: false, message: `Description can be up to ${FOLDER_DESCRIPTION_MAX} characters.` };
  }
  if (genre.length > FOLDER_GENRE_MAX) {
    return { ok: false, message: `Genre can be up to ${FOLDER_GENRE_MAX} characters.` };
  }

  return {
    ok: true,
    patch: {
      description: description || null,
      collection_year: year,
      collection_type: form.type,
      genre: genre || null,
    },
  };
}

// Only the metadata columns that differ from `base` (a saved folder, or
// nothing for a new one) — so an insert omits empty fields and an update
// touches only what the user changed. Besides keeping writes minimal, a
// folder saved without touching its metadata sends exactly the payload it
// did before these columns existed.
export function changedFolderMetadata(
  patch: FolderMetadataPatch,
  base?: Pick<Folder, 'description' | 'collection_year' | 'collection_type' | 'genre'>,
): Partial<FolderMetadataPatch> {
  const changed: Partial<FolderMetadataPatch> = {};
  if (patch.description !== (base?.description ?? null)) changed.description = patch.description;
  if (patch.collection_year !== (base?.collection_year ?? null)) changed.collection_year = patch.collection_year;
  if (patch.collection_type !== (base?.collection_type ?? null)) changed.collection_type = patch.collection_type;
  if (patch.genre !== (base?.genre ?? null)) changed.genre = patch.genre;
  return changed;
}

// "2026 · Sports Cards · Basketball" — populated parts only; null when
// there is nothing to show.
export function folderMetadataLine(folder: Folder): string | null {
  const parts = [
    folder.collection_year != null ? String(folder.collection_year) : null,
    folderCollectionTypeLabel(folder.collection_type),
    folder.genre?.trim() || null,
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join(' · ') : null;
}
