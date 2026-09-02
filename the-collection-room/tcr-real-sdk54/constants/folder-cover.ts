// Shared between app/collection/[folderId].tsx (the hero banner itself)
// and components/collection/folder-cover-adjuster.tsx (the pan/zoom
// composer) — both MUST use the exact same aspect ratio for the adjuster
// to be truly WYSIWYG. Square corners (0) — a banner, not a rounded
// trading-card tile, matching this screen's own Instagram-style grid.
export const FOLDER_COVER_ASPECT_RATIO = 1.55;
export const FOLDER_COVER_RADIUS = 0;
