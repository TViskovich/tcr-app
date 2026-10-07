import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { SafeAreaView } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';

import {
  LEGACY_PROFILE_BANNER,
  PROFILE_BANNER_VARIANT_IDS,
  PROFILE_BANNER_VARIANTS,
  type ProfileBannerVariant,
} from './profile-banner-variants';
import { ProfileV2IdentityCard } from './profile-v2-identity-card';
import { PV2 } from './profile-v2-theme';

// Edit Profile's "Banner Style" row + its picker sheet. Each option is a
// live ProfileV2IdentityCard rendered with the owner's own data, so the
// preview is exactly what the profile will show (current CacheCase logo
// included — banner choice never changes the logo). Choosing an option only
// updates the caller's draft; it's persisted by Edit Profile's own Save.
//
// value null = a pre-banner profile still on the original neon frame. The
// row reads "Original" and no option is checked; "Original" itself isn't
// offered as a choice, so once a banner is saved there's no way back to it.
type Props = {
  value: ProfileBannerVariant | null;
  onChange: (next: ProfileBannerVariant) => void;
  preview: {
    username: string;
    title: string;
    itemCount: number;
    avatarUri: string | null;
    accountNumber: number | null | undefined;
  };
};

export function ProfileV2BannerPicker({ value, onChange, preview }: Props) {
  const [open, setOpen] = useState(false);
  const currentLabel = (value ? PROFILE_BANNER_VARIANTS[value] : LEGACY_PROFILE_BANNER).label;

  return (
    <>
      <TouchableOpacity
        style={styles.row}
        onPress={() => setOpen(true)}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={`Banner style, ${currentLabel}`}>
        <Text style={styles.rowLabel}>Banner Style</Text>
        <Text style={styles.rowValue}>{currentLabel}</Text>
        <IconSymbol name="chevron.right" size={14} color={PV2.textTertiary} />
      </TouchableOpacity>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.sheet} edges={['top', 'bottom']}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Banner Style</Text>
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={10} accessibilityRole="button">
              <Text style={styles.done}>Done</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.list}>
            {PROFILE_BANNER_VARIANT_IDS.map((id) => {
              const selected = id === value;
              return (
                <Pressable
                  key={id}
                  style={styles.option}
                  onPress={() => {
                    onChange(id);
                    setOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={PROFILE_BANNER_VARIANTS[id].label}>
                  <View style={styles.optionHeader}>
                    <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>
                      {PROFILE_BANNER_VARIANTS[id].label}
                    </Text>
                    {selected ? <IconSymbol name="checkmark.circle.fill" size={14} color={PV2.textPrimary} /> : null}
                  </View>
                  {/* Preview only — the card's own touch targets are disabled
                      so the whole option is one tap target. */}
                  <View pointerEvents="none">
                    <ProfileV2IdentityCard {...preview} bannerVariant={id} />
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: PV2.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PV2.panelBorder,
  },
  rowLabel: {
    flex: 1,
    fontSize: 15,
    color: PV2.textPrimary,
  },
  rowValue: {
    fontSize: 14,
    color: PV2.textSecondary,
  },
  sheet: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  done: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.link,
  },
  list: {
    paddingBottom: 32,
  },
  option: {
    paddingTop: 16,
  },
  optionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
  },
  optionLabel: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: PV2.textSecondary,
  },
  optionLabelSelected: {
    color: PV2.textPrimary,
  },
});
