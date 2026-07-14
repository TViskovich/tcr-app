import { Circle, Line, Polygon, Path } from 'react-native-svg';

export type FolderIconKey = 'basketball' | 'baseball' | 'football' | 'hockey' | 'soccer' | 'other';

// Case-insensitive contains-match against the folder name. Order matters:
// soccer is checked before the generic football/nfl check so a name like
// "Football (Soccer)" — which contains both words — resolves to soccer, the
// more specific match, rather than being caught by the broader football rule.
export function detectFolderIcon(name: string): FolderIconKey {
  const n = name.toLowerCase();
  if (n.includes('basket') || n.includes('bball')) return 'basketball';
  if (n.includes('baseball') || n.includes('mlb')) return 'baseball';
  if (n.includes('hockey') || n.includes('nhl')) return 'hockey';
  if (n.includes('soccer') || n.includes('futbol')) return 'soccer';
  if (n.includes('football') || n.includes('nfl')) return 'football';
  return 'other';
}

// Plain outline shapes only (fill="none") — no color is set here. Each
// shape uses stroke="currentColor" so folder-card.tsx can render this same
// glyph three times (dark/light/base) inside three <Svg color="..."> layers
// to fake the same carved-in emboss look the old letter treatment used.
const STROKE_WIDTH = 2;

export function FolderIconGlyph({ icon }: { icon: FolderIconKey }) {
  switch (icon) {
    case 'basketball':
      return (
        <>
          <Circle cx={20} cy={20} r={15} stroke="currentColor" strokeWidth={STROKE_WIDTH} fill="none" />
          <Line x1={20} y1={5} x2={20} y2={35} stroke="currentColor" strokeWidth={STROKE_WIDTH} />
          <Line x1={5} y1={20} x2={35} y2={20} stroke="currentColor" strokeWidth={STROKE_WIDTH} />
          <Path d="M20 5 Q8 20 20 35" stroke="currentColor" strokeWidth={STROKE_WIDTH} fill="none" />
          <Path d="M20 5 Q32 20 20 35" stroke="currentColor" strokeWidth={STROKE_WIDTH} fill="none" />
        </>
      );
    case 'baseball':
      return (
        <>
          <Circle cx={20} cy={20} r={15} stroke="currentColor" strokeWidth={STROKE_WIDTH} fill="none" />
          <Path d="M11 8 Q20 20 11 32" stroke="currentColor" strokeWidth={STROKE_WIDTH} fill="none" />
          <Path d="M29 8 Q20 20 29 32" stroke="currentColor" strokeWidth={STROKE_WIDTH} fill="none" />
          {/* Stitch ticks along each seam */}
          <Line x1={9} y1={13} x2={13} y2={11.5} stroke="currentColor" strokeWidth={1.4} />
          <Line x1={9} y1={27} x2={13} y2={28.5} stroke="currentColor" strokeWidth={1.4} />
          <Line x1={31} y1={13} x2={27} y2={11.5} stroke="currentColor" strokeWidth={1.4} />
          <Line x1={31} y1={27} x2={27} y2={28.5} stroke="currentColor" strokeWidth={1.4} />
        </>
      );
    case 'football':
      return (
        <>
          <Path d="M20 5 Q30 20 20 35 Q10 20 20 5 Z" stroke="currentColor" strokeWidth={STROKE_WIDTH} fill="none" />
          <Line x1={20} y1={13} x2={20} y2={27} stroke="currentColor" strokeWidth={STROKE_WIDTH} />
          <Line x1={17} y1={16} x2={23} y2={16} stroke="currentColor" strokeWidth={1.4} />
          <Line x1={17} y1={20} x2={23} y2={20} stroke="currentColor" strokeWidth={1.4} />
          <Line x1={17} y1={24} x2={23} y2={24} stroke="currentColor" strokeWidth={1.4} />
        </>
      );
    case 'hockey':
      return (
        <>
          <Path d="M14 6 L22 30 L32 33" stroke="currentColor" strokeWidth={STROKE_WIDTH} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <Circle cx={31} cy={35} r={3} stroke="currentColor" strokeWidth={1.6} fill="none" />
        </>
      );
    case 'soccer':
      return (
        <>
          <Circle cx={20} cy={20} r={15} stroke="currentColor" strokeWidth={STROKE_WIDTH} fill="none" />
          <Polygon
            points="20,14 25.7,18.15 23.53,24.85 16.47,24.85 14.29,18.15"
            stroke="currentColor"
            strokeWidth={1.4}
            fill="none"
          />
          <Line x1={20} y1={14} x2={20} y2={6} stroke="currentColor" strokeWidth={1.2} />
          <Line x1={25.7} y1={18.15} x2={33.3} y2={15.67} stroke="currentColor" strokeWidth={1.2} />
          <Line x1={23.53} y1={24.85} x2={28.2} y2={31.3} stroke="currentColor" strokeWidth={1.2} />
          <Line x1={16.47} y1={24.85} x2={11.8} y2={31.3} stroke="currentColor" strokeWidth={1.2} />
          <Line x1={14.29} y1={18.15} x2={6.7} y2={15.67} stroke="currentColor" strokeWidth={1.2} />
        </>
      );
    case 'other':
    default:
      return (
        <Polygon
          points="20,5 23.53,15.15 34.27,15.36 25.71,21.85 28.82,32.14 20,26 11.18,32.14 14.29,21.85 5.73,15.36 16.47,15.15"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
          strokeLinejoin="round"
          fill="none"
        />
      );
  }
}
