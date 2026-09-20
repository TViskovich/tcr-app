-- Folder hero/cover: non-destructive pan/zoom framing for an 'item' cover
-- (see 20260901120000_add_folder_cover_item_id.sql for cover_item_id
-- itself). The referenced item's image is never copied or modified —
-- cover_crop only stores how to position/zoom it within the hero's fixed
-- ~1.55:1 frame.
--
-- Shape: { x: number, y: number, scale: number }
--   x, y    — normalized focal point (0-1) within the referenced item's own
--             image, i.e. the image-native pixel fraction that should sit
--             centered in the hero frame.
--   scale   — zoom multiplier relative to "just covers the frame, no gaps"
--             (1 = that baseline, >1 = zoomed in further).
-- Deliberately resolution/device-independent — no absolute pixel offsets or
-- container-relative values — so the same crop renders correctly at any
-- window width or if the item's image is later re-fetched at a different
-- decoded size. Computed by components/collection/folder-cover-adjuster.tsx
-- and applied by components/collection/folder-cover-image.tsx (see
-- lib/folder-cover-crop.ts for the shared math both use).
--
-- Only ever meaningful when cover_source = 'item'; null for 'upload' and
-- 'first_card' folders, and for pre-existing 'item' covers created before
-- this feature shipped (those keep rendering with the same centered
-- contentFit="cover" behavior they always had). A single JSONB column
-- rather than three numeric ones: x/y/scale only ever read or write
-- together, so there's no case where splitting them into separate columns
-- buys anything.
ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS cover_crop jsonb;

NOTIFY pgrst, 'reload schema';
