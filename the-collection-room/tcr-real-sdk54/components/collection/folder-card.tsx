// Premium leather binder tones — the live source for FolderColorPicker's
// swatches and the name-hash fallback used at app/folder/[id].tsx.
//
// The FolderCard component that used to render these (the leather-binder
// art tiles) was removed once both the main Collection page and the
// profile Collections section moved to CollectionPreviewSection's
// photo-cover design (components/collection/collection-preview-section.tsx)
// — this file now only holds the color registry, which is still live.
export type FolderColorKey = 'graphite' | 'navy' | 'forest' | 'plum' | 'chestnut' | 'charcoal';

export const LEATHER_TONES: Record<
  FolderColorKey,
  { base: string; spine: string; sheenLight: string; sheenDark: string }
> = {
  graphite: { base: '#2C2C2F', spine: '#131315', sheenLight: 'rgba(255,255,255,0.065)', sheenDark: 'rgba(0,0,0,0.24)' },
  navy: { base: '#26374C', spine: '#101B28', sheenLight: 'rgba(255,255,255,0.07)', sheenDark: 'rgba(0,0,0,0.24)' },
  forest: { base: '#213A2A', spine: '#0D1912', sheenLight: 'rgba(255,255,255,0.065)', sheenDark: 'rgba(0,0,0,0.25)' },
  plum: { base: '#332543', spine: '#170F20', sheenLight: 'rgba(255,255,255,0.07)', sheenDark: 'rgba(0,0,0,0.25)' },
  chestnut: { base: '#4C3320', spine: '#291A0E', sheenLight: 'rgba(255,255,255,0.075)', sheenDark: 'rgba(0,0,0,0.24)' },
  charcoal: { base: '#2E363D', spine: '#161B1F', sheenLight: 'rgba(255,255,255,0.065)', sheenDark: 'rgba(0,0,0,0.24)' },
};

export const FOLDER_COLOR_KEYS = Object.keys(LEATHER_TONES) as FolderColorKey[];
