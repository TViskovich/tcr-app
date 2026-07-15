import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PV2 } from './profile-v2-theme';

// The reference shows a two-line "cache/case" wordmark lockup that doesn't
// match any exported CacheCaseLogo asset (icon: square grid mark; light/
// dark: a single-line wide wordmark) — approximated here with styled Text
// plus the existing small grid icon, rather than inventing a new PNG asset.
const IRIDESCENT_BORDER = ['#8FE3C0', '#F2A6C9', '#8FC7EA', '#B9E8B0'] as const;

export type ProfileV2Section = 'posts' | 'cachecase' | 'collections';

const SECTIONS: ProfileV2Section[] = ['posts', 'cachecase', 'collections'];

type Props = {
  active: ProfileV2Section;
  onChange: (section: ProfileV2Section) => void;
};

// Local-state tab selector — does not touch the app's bottom Tabs navigator.
export function ProfileV2Selector({ active, onChange }: Props) {
  return (
    <View style={styles.wrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}>
        <TouchableOpacity
          style={[styles.pill, active === 'posts' && styles.pillActive]}
          onPress={() => onChange('posts')}
          activeOpacity={0.8}>
          <Text style={[styles.pillLabel, active === 'posts' && styles.pillLabelActive]}>posts</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => onChange('cachecase')} activeOpacity={0.85}>
          <LinearGradient
            colors={IRIDESCENT_BORDER}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[styles.cachecaseBorder, active === 'cachecase' ? styles.pillActiveSize : styles.pillInactiveSize]}>
            <View style={styles.cachecasePill}>
              <View>
                <Text style={styles.cachecaseWordTop}>cache</Text>
                <Text style={styles.cachecaseWordBottom}>case</Text>
              </View>
              <CacheCaseLogo variant="icon" size={12} style={styles.cachecaseIcon} />
            </View>
          </LinearGradient>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.pill, active === 'collections' && styles.pillActive]}
          onPress={() => onChange('collections')}
          activeOpacity={0.8}>
          <Text style={[styles.pillLabel, active === 'collections' && styles.pillLabelActive]}>collections</Text>
        </TouchableOpacity>
      </ScrollView>

      <View style={styles.dots}>
        {SECTIONS.map((s) => (
          <View key={s} style={[styles.dot, s === active && styles.dotActive]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 10,
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
  },
  pill: {
    height: 38,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Active pill: 108x44 (overrides the 38px inactive height above).
  pillActive: {
    width: 108,
    height: 44,
    backgroundColor: 'rgba(16,16,26,0.92)',
    borderWidth: 0,
  },
  // Same 108x44 active / 38-tall inactive sizing applied to the cachecase
  // pill's outer gradient-border wrapper, so all three pills share one
  // active/inactive size language.
  pillActiveSize: {
    width: 108,
    height: 44,
  },
  pillInactiveSize: {
    height: 38,
  },
  // Gradient rect that shows through as a thin border around the black
  // interior — the standard "gradient border" trick (padding = border width).
  cachecaseBorder: {
    borderRadius: 13,
    padding: 1.5,
  },
  cachecasePill: {
    flex: 1,
    minWidth: 76,
    paddingHorizontal: 10,
    borderRadius: 11.5,
    backgroundColor: 'rgba(16,16,26,0.92)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  cachecaseWordTop: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
    fontStyle: 'italic',
    lineHeight: 12,
  },
  cachecaseWordBottom: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
    fontStyle: 'italic',
    lineHeight: 12,
  },
  cachecaseIcon: {},
  pillLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.9,
    textTransform: 'lowercase',
  },
  pillLabelActive: {
    color: '#fff',
    fontSize: 13,
    letterSpacing: 1.0,
  },
  dots: {
    flexDirection: 'row',
    gap: 5,
    marginTop: 10,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  dotActive: {
    width: 16,
    backgroundColor: PV2.accent,
  },
});
