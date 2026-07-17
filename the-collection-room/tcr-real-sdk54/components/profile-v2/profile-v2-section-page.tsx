import type { ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';

type Props = {
  children: ReactNode;
  // Once measured (see profile.tsx), every section gets this same floor —
  // shorter sections (posts/collections) leave empty space below their
  // content instead of shrinking the page, so switching between
  // ProfileV2Selector tabs doesn't change the screen's total height.
  minHeight?: number;
  onLayout?: (e: LayoutChangeEvent) => void;
};

// Structural only — no background/border/radius of its own, since the
// individual section components (ProfileV2CollectorPanel, ProfileV2Grid,
// etc.) already own their own visuals and none of that should change here.
export function ProfileV2SectionPage({ children, minHeight, onLayout }: Props) {
  return (
    <View style={[styles.page, minHeight != null && { minHeight }]} onLayout={onLayout}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    width: '100%',
  },
});
