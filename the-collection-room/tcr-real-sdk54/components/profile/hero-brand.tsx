import { StyleSheet, Text, View } from 'react-native';

type Props = {
  // Optional — defaults to 'SHOWCASE'. Later phases will accept uploaded logos or SVGs.
  label?: string;
};

export function HeroBrand({ label = 'SHOWCASE' }: Props) {
  return (
    <View style={styles.wrap} pointerEvents="none">
      <Text style={styles.wordmark} adjustsFontSizeToFit numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 10,
    left: 24,
    right: 24,
    alignItems: 'center',
    // Counter-clockwise tilt — reads as casually stamped rather than a page title.
    transform: [{ rotate: '-6deg' }],
  },
  wordmark: {
    fontFamily: 'MarkerFelt-Wide',
    fontSize: 44,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: '#FFFFFF',
    textShadowColor: 'rgba(0, 0, 0, 0.35)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 3,
  },
});
