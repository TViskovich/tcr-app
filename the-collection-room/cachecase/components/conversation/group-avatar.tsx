import { StyleSheet, Text, View } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

type Props = {
  // Members' display names (the others, not the viewer); the first two give
  // the initials.
  names: string[];
  size: number;
};

// A group's default avatar: two overlapping initial circles (first two other
// members), so a group reads differently from a one-person DM avatar at a
// glance. No image — groups don't have photos in M1.
export function GroupAvatar({ names, size }: Props) {
  const initials = names.slice(0, 2).map((n) => n.trim().charAt(0).toUpperCase() || '?');
  const inner = Math.round(size * 0.68);
  const fontSize = Math.round(inner * 0.42);

  if (initials.length < 2) {
    return (
      <View style={[styles.circle, styles.single, { width: size, height: size, borderRadius: size / 2 }]}>
        <Text style={[styles.initial, { fontSize: Math.round(size * 0.42) }]}>{initials[0] ?? '?'}</Text>
      </View>
    );
  }

  return (
    <View style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.circle, styles.back, { width: inner, height: inner, borderRadius: inner / 2 }]}>
        <Text style={[styles.initial, { fontSize }]}>{initials[0]}</Text>
      </View>
      <View
        style={[
          styles.circle,
          styles.front,
          { width: inner, height: inner, borderRadius: inner / 2, left: size - inner, top: size - inner },
        ]}>
        <Text style={[styles.initial, { fontSize }]}>{initials[1]}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: PV2.border,
  },
  single: {
    backgroundColor: PV2.panel,
  },
  back: {
    position: 'absolute',
    left: 0,
    top: 0,
    backgroundColor: PV2.panel,
  },
  // The front circle sits on the back one (opaque, a violet-tinted panel in
  // the chat accent's family); its ring in the background color separates
  // the two.
  front: {
    position: 'absolute',
    backgroundColor: '#24203a',
    borderWidth: 2,
    borderColor: PV2.bg,
  },
  initial: {
    fontWeight: '700',
    color: PV2.textPrimary,
  },
});
