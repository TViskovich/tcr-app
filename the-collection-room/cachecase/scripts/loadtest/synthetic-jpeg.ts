// Original, dependency-free placeholder JPEGs for load-test seeding.
//
// The encoder writes a standard baseline JFIF (SOF0, YCbCr 4:4:4, Huffman)
// in which every 8x8 block is one flat colour. A flat block's DCT has only a
// DC coefficient, so each block is encoded exactly as one DC difference plus
// an end-of-block code — no AC coefficients, no lossy rounding. That keeps
// this file tiny while producing real JPEGs any decoder (and Supabase's image
// transformer) accepts. All artwork is drawn here from simple shapes; no
// third-party images are used.

type Rgb = [number, number, number];

// 5:7, the app's card media ratio. Both must be multiples of 8.
export const PLACEHOLDER_WIDTH = 480;
export const PLACEHOLDER_HEIGHT = 672;

// ── Encoder ─────────────────────────────────────────────────────────────

// Standard JPEG luminance DC table (ITU-T T.81 Annex K.3): code-length
// counts for lengths 1–16, then the 12 size categories in code order.
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
// Every block's AC run is just end-of-block (symbol 0x00), so the AC table
// holds that single symbol as the 1-bit code "0".
const AC_BITS = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const AC_VALUES = [0x00];
// Quantizer 8 makes the stored DC exactly (sample - 128): a flat block's DC
// coefficient is 8 x (sample - 128).
const QUANT = 8;

function huffmanCodes(bits: number[], values: number[]) {
  const codes = new Map<number, { code: number; length: number }>();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < bits[length - 1]; i++) codes.set(values[k++], { code: code++, length });
    code <<= 1;
  }
  return codes;
}
const DC_CODES = huffmanCodes(DC_BITS, DC_VALUES);

class BitWriter {
  bytes: number[] = [];
  private acc = 0;
  private count = 0;

  write(value: number, length: number) {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      if (++this.count === 8) this.flushByte();
    }
  }

  // Pads the final byte with 1-bits, as the standard requires.
  finish() {
    while (this.count !== 0) this.write(1, 1);
  }

  private flushByte() {
    this.bytes.push(this.acc);
    if (this.acc === 0xff) this.bytes.push(0x00); // byte stuffing
    this.acc = 0;
    this.count = 0;
  }
}

function toYCbCr([r, g, b]: Rgb): Rgb {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [
    clamp(0.299 * r + 0.587 * g + 0.114 * b),
    clamp(-0.168736 * r - 0.331264 * g + 0.5 * b + 128),
    clamp(0.5 * r - 0.418688 * g - 0.081312 * b + 128),
  ];
}

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

// Encodes an image whose colour is constant within each 8x8 block;
// colorAt(bx, by) returns the RGB of block column bx, block row by.
export function encodeBlockJpeg(width: number, height: number, colorAt: (bx: number, by: number) => Rgb): Uint8Array {
  if (width % 8 || height % 8) throw new Error('JPEG dimensions must be multiples of 8');
  const blocksX = width / 8;
  const blocksY = height / 8;

  const writer = new BitWriter();
  const predictors = [0, 0, 0];
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const ycc = toYCbCr(colorAt(bx, by));
      for (let c = 0; c < 3; c++) {
        const dc = ycc[c] - 128;
        const diff = dc - predictors[c];
        predictors[c] = dc;
        const size = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1;
        const { code, length } = DC_CODES.get(size)!;
        writer.write(code, length);
        if (size > 0) writer.write(diff > 0 ? diff : diff + (1 << size) - 1, size);
        writer.write(0, 1); // AC: end-of-block
      }
    }
  }
  writer.finish();

  const components = [1, 2, 3];
  const bytes = [
    0xff, 0xd8, // SOI
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]), // APP0 JFIF 1.01
    ...segment(0xdb, [0x00, ...new Array(64).fill(QUANT)]), // DQT, table 0
    ...segment(0xc0, [
      8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3,
      ...components.flatMap((id) => [id, 0x11, 0]), // 1x1 sampling, table 0
    ]), // SOF0
    ...segment(0xc4, [0x00, ...DC_BITS, ...DC_VALUES]), // DHT DC 0
    ...segment(0xc4, [0x10, ...AC_BITS, ...AC_VALUES]), // DHT AC 0
    ...segment(0xda, [3, ...components.flatMap((id) => [id, 0x00]), 0, 63, 0]), // SOS
    ...writer.bytes,
    0xff, 0xd9, // EOI
  ];
  return Uint8Array.from(bytes);
}

// ── Placeholder artwork ─────────────────────────────────────────────────

// 3x5 glyphs, '#' = filled.
const GLYPHS: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '###', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  '-': ['...', '...', '###', '...', '...'],
  ' ': ['...', '...', '...', '...', '...'],
};

const PALETTE: Rgb[] = [
  [52, 101, 164], [204, 85, 0], [46, 139, 87], [142, 68, 173], [192, 57, 43],
  [22, 160, 133], [211, 84, 120], [41, 128, 185], [127, 140, 141], [180, 140, 20],
];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;
const WHITE: Rgb = [245, 243, 238];
const INK: Rgb = [28, 30, 36];

// A trading-card-like placeholder: frame, striped "photo" window, and a
// label band showing `label` (digits, spaces and '-' only). `variant`
// picks the colour scheme, so different items look different.
export function renderPlaceholderCard(label: string, variant: number): Uint8Array {
  const base = PALETTE[variant % PALETTE.length];
  const accent = PALETTE[(variant * 3 + 4) % PALETTE.length];
  const blocksX = PLACEHOLDER_WIDTH / 8; // 60
  const blocksY = PLACEHOLDER_HEIGHT / 8; // 84

  // Label rendered at 2x2 blocks per glyph pixel, centred in the band.
  const scale = 2;
  const glyphWidth = 3 * scale;
  const gap = scale;
  const textWidth = label.length * glyphWidth + (label.length - 1) * gap;
  const textX = Math.floor((blocksX - textWidth) / 2);
  const textY = 64;

  function textPixel(bx: number, by: number): boolean {
    const x = bx - textX;
    const y = by - textY;
    if (x < 0 || y < 0 || x >= textWidth || y >= 5 * scale) return false;
    const charIndex = Math.floor(x / (glyphWidth + gap));
    const xInChar = x - charIndex * (glyphWidth + gap);
    if (xInChar >= glyphWidth) return false;
    const glyph = GLYPHS[label[charIndex]] ?? GLYPHS[' '];
    return glyph[Math.floor(y / scale)][Math.floor(xInChar / scale)] === '#';
  }

  return encodeBlockJpeg(PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT, (bx, by) => {
    const edge = Math.min(bx, by, blocksX - 1 - bx, blocksY - 1 - by);
    if (edge < 2) return WHITE; // outer frame
    if (by >= 58 && by <= 77 && bx >= 4 && bx <= blocksX - 5) {
      return textPixel(bx, by) ? INK : WHITE; // label band
    }
    if (by >= 6 && by <= 53 && bx >= 6 && bx <= blocksX - 7) {
      // "photo" window: diagonal stripes
      return (bx + by) % 10 < 5 ? mix(accent, WHITE, 0.25) : mix(accent, INK, 0.2);
    }
    return mix(base, INK, by / blocksY / 2); // card body, darkening downward
  });
}
