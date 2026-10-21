import { type ColorValue, Pressable, StyleSheet, Text, View } from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';

import { GRAILS_SHOWCASE_EFFECT_IDS, GRAILS_SHOWCASE_EFFECTS, type GrailsShowcaseEffect } from './grails-showcase-effects';
import { PV2 } from './profile-v2-theme';

// Edit Profile's Grails Effect picker: three compact, stacked option cards
// (Off / Animated Dividers / Static Outlines), each with a small grid glyph
// tinted in the draft banner's colours. Selection only updates the draft —
// the parent previews it live on the Grails and saves it with the profile.

type Props = {
  value: GrailsShowcaseEffect;
  onChange: (next: GrailsShowcaseEffect) => void;
  // The draft banner's theme colours (getProfileBannerAccent(...).colors).
  colors: readonly ColorValue[];
};

export function GrailsEffectPicker({ value, onChange, colors }: Props) {
  return (
    <View style={styles.list} accessibilityRole="radiogroup" accessibilityLabel="Grails Effect">
      {GRAILS_SHOWCASE_EFFECT_IDS.map((id) => {
        const selected = value === id;
        const { label, hint } = GRAILS_SHOWCASE_EFFECTS[id];
        return (
          <Pressable
            key={id}
            onPress={() => onChange(id)}
            style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.optionPressed]}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityHint={hint}
            accessibilityState={{ checked: selected }}>
            <EffectGlyph effect={id} colors={colors} />
            <View style={styles.text}>
              <Text style={styles.title}>{label}</Text>
              <Text style={styles.hint} numberOfLines={1}>
                {hint}
              </Text>
            </View>
            <View style={[styles.radio, selected && styles.radioSelected]}>
              {selected && <View style={styles.radioDot} />}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Glyph: a tiny 3×3 Grails grid ───────────────────────────────────────────
const GLYPH_CELL_W = 7;
const GLYPH_CELL_H = 9;
const GLYPH_GAP = 2;
const GLYPH_W = GLYPH_CELL_W * 3 + GLYPH_GAP * 2;
const GLYPH_H = GLYPH_CELL_H * 3 + GLYPH_GAP * 2;

type GradientColors = readonly [ColorValue, ColorValue, ...ColorValue[]];

function EffectGlyph({ effect, colors }: { effect: GrailsShowcaseEffect; colors: readonly ColorValue[] }) {
  const [first = PV2.actionPrimary, second = first, ...others] = colors;
  const gradient: GradientColors = [first, second, ...others];
  // Static Outlines: each column's outline takes the theme colour at that
  // point of the banner (left, middle, right) — the same left→right sweep.
  const columnColor = (col: number) => gradient[Math.round((col / 2) * (gradient.length - 1))];

  return (
    <View style={styles.glyphWell}>
      <View style={styles.glyph}>
        {/* Animated Dividers: the theme gradient showing through the gaps. */}
        {effect === 'animated_dividers' && (
          <LinearGradient
            colors={gradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[StyleSheet.absoluteFill, styles.glyphGlow]}
          />
        )}
        {[0, 1, 2].map((row) => (
          <View key={row} style={styles.glyphRow}>
            {[0, 1, 2].map((col) => (
              <View
                key={col}
                style={[
                  styles.glyphCell,
                  effect === 'static_outlines' && [styles.glyphCellOutlined, { borderColor: columnColor(col) }],
                ]}
              />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    marginTop: 10,
    gap: 8,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    backgroundColor: PV2.panel,
  },
  optionSelected: {
    borderColor: PV2.actionPrimary,
    backgroundColor: PV2.actionPrimarySoft,
  },
  optionPressed: {
    opacity: 0.8,
  },
  text: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  hint: {
    fontSize: 12,
    color: PV2.textTertiary,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: PV2.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: {
    borderColor: PV2.actionPrimary,
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: PV2.actionPrimary,
  },
  glyphWell: {
    width: 40,
    height: 40,
    borderRadius: 9,
    backgroundColor: PV2.bg,
    borderWidth: 1,
    borderColor: PV2.dividerColor,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: {
    width: GLYPH_W,
    height: GLYPH_H,
    gap: GLYPH_GAP,
  },
  glyphGlow: {
    opacity: 0.85,
  },
  glyphRow: {
    flexDirection: 'row',
    gap: GLYPH_GAP,
  },
  // Opaque, so for Animated Dividers the gradient shows only in the gaps.
  glyphCell: {
    width: GLYPH_CELL_W,
    height: GLYPH_CELL_H,
    backgroundColor: '#2A2A30',
  },
  glyphCellOutlined: {
    borderWidth: 1,
  },
});
