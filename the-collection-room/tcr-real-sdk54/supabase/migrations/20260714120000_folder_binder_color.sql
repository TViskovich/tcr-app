-- Lets a user pick a binder color when creating/editing a folder, instead of
-- always auto-assigning one by hashing the folder name (folder-card.tsx's
-- leatherTone()). Nullable and additive — existing folders keep rendering
-- with their current hash-derived color until the user explicitly sets one.
--
-- Valid values are the FolderColorKey keys in
-- components/collection/folder-card.tsx: 'graphite' | 'navy' | 'forest' |
-- 'plum' | 'chestnut' | 'charcoal'. Not enforced with a CHECK constraint —
-- an unrecognized/legacy value is treated the same as null (falls back to
-- the name-hash color) by leatherTone(), so this stays forward-compatible
-- if the palette changes later.
ALTER TABLE public.folders ADD COLUMN IF NOT EXISTS color text;

NOTIFY pgrst, 'reload schema';
