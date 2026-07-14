import { useCallback, useRef, useState } from 'react';
import {
  Animated,
  ActivityIndicator,
  Alert,
  type AlertButton,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { GrailsGrid } from '@/components/profile/grails-grid';
import { ProfileHero } from '@/components/profile/profile-hero';
import {
  getHeroCanvasPickerThemes,
  resolveHeroCanvasTheme,
  type HeroCanvasThemeId,
} from '@/components/profile/hero-canvas-themes';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useProfile } from '@/hooks/use-profile';
import { useGrails } from '@/hooks/use-grails';
import { useAuth } from '@/lib/auth';
import { uploadAvatar, uploadBadgeImage, uploadHeroImage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';

export default function ProfileScreen() {
  const { session } = useAuth();
  const userId = session?.user?.id;
  const router = useRouter();
  const { profile, loading, refresh } = useProfile(userId);
  const { grails, refresh: refreshGrails } = useGrails(userId);

  const scrollY = useRef(new Animated.Value(0)).current;

  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState({ heroName: '', displayName: '', bio: '' });
  const [newAvatarUri, setNewAvatarUri] = useState<string | null>(null);
  const [newHeroUri, setNewHeroUri] = useState<string | null>(null);
  const [removeHero, setRemoveHero] = useState(false);
  const [newBadgeUri, setNewBadgeUri] = useState<string | null>(null);
  const [removeBadge, setRemoveBadge] = useState(false);
  const [selectedTheme, setSelectedTheme] = useState<HeroCanvasThemeId>('classic');
  const [saving, setSaving] = useState(false);

  useFocusEffect(
    useCallback(() => {
      refresh();
      refreshGrails();
    }, [refresh, refreshGrails]),
  );

  function enterEdit() {
    setEditForm({
      heroName: profile?.hero_display_name ?? '',
      displayName: profile?.display_name ?? '',
      bio: profile?.bio ?? '',
    });
    setNewAvatarUri(null);
    setNewHeroUri(null);
    setRemoveHero(false);
    setNewBadgeUri(null);
    setRemoveBadge(false);
    setSelectedTheme(resolveHeroCanvasTheme(profile?.hero_theme));
    setEditMode(true);
  }

  function handlePillPress(id: string) {
    if (id === 'grails') {
      router.push({
        pathname: '/grails/[userId]',
        params: {
          userId: userId ?? '',
          username: profile?.username ?? '',
          displayName: profile?.display_name ?? '',
        },
      });
    } else if (id === 'folders') {
      router.push('/(tabs)/collection' as any);
    }
  }

  function cancelEdit() {
    setNewAvatarUri(null);
    setNewHeroUri(null);
    setRemoveHero(false);
    setNewBadgeUri(null);
    setRemoveBadge(false);
    setEditMode(false);
  }

  async function launchCamera() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow camera access in settings.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setNewAvatarUri(result.assets[0].uri);
    }
  }

  async function launchLibrary() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow photo library access in settings.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setNewAvatarUri(result.assets[0].uri);
    }
  }

  function pickAvatar() {
    Alert.alert('Change Photo', undefined, [
      { text: 'Take Photo', onPress: launchCamera },
      { text: 'Choose from Library', onPress: launchLibrary },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  async function pickHeroFromLibrary() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow photo library access in settings.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setNewHeroUri(result.assets[0].uri);
      setRemoveHero(false);
    }
  }

  async function pickHeroFromCamera() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow camera access in settings.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setNewHeroUri(result.assets[0].uri);
      setRemoveHero(false);
    }
  }

  function pickHero() {
    const canRemove = !!(profile?.hero_image_url || newHeroUri);
    const options: AlertButton[] = [
      { text: 'Take Photo', onPress: pickHeroFromCamera },
      { text: 'Choose from Library', onPress: pickHeroFromLibrary },
    ];
    if (canRemove) {
      options.push({
        text: 'Remove Banner',
        style: 'destructive',
        onPress: () => {
          setNewHeroUri(null);
          setRemoveHero(true);
        },
      });
    }
    options.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Change Banner', undefined, options);
  }

  async function pickBadgeFromLibrary() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow photo library access in settings.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setNewBadgeUri(result.assets[0].uri);
      setRemoveBadge(false);
    }
  }

  async function pickBadgeFromCamera() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow camera access in settings.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setNewBadgeUri(result.assets[0].uri);
      setRemoveBadge(false);
    }
  }

  function pickBadge() {
    const canRemove = !!(profile?.showcase_badge_url || newBadgeUri);
    const options: AlertButton[] = [
      { text: 'Take Photo', onPress: pickBadgeFromCamera },
      { text: 'Choose from Library', onPress: pickBadgeFromLibrary },
    ];
    if (canRemove) {
      options.push({
        text: 'Remove Badge',
        style: 'destructive',
        onPress: () => {
          setNewBadgeUri(null);
          setRemoveBadge(true);
        },
      });
    }
    options.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Change Badge', undefined, options);
  }

  async function handleSave() {
    if (!userId) return;
    setSaving(true);
    try {
      let avatarUrl = profile?.avatar_url ?? null;
      if (newAvatarUri) {
        try {
          avatarUrl = await uploadAvatar(newAvatarUri, userId);
        } catch (uploadErr: unknown) {
          const detail = uploadErr instanceof Error ? uploadErr.message : 'unknown';
          throw new Error(`Avatar upload failed: ${detail}`);
        }
      }

      let heroUrl: string | null;
      if (newHeroUri) {
        try {
          heroUrl = await uploadHeroImage(newHeroUri, userId);
        } catch (uploadErr: unknown) {
          const detail = uploadErr instanceof Error ? uploadErr.message : 'unknown';
          throw new Error(`Banner upload failed: ${detail}`);
        }
      } else if (removeHero) {
        heroUrl = null;
      } else {
        heroUrl = profile?.hero_image_url ?? null;
      }

      let badgeUrl: string | null;
      if (newBadgeUri) {
        try {
          badgeUrl = await uploadBadgeImage(newBadgeUri, userId);
        } catch (uploadErr: unknown) {
          const detail = uploadErr instanceof Error ? uploadErr.message : 'unknown';
          throw new Error(`Badge upload failed: ${detail}`);
        }
      } else if (removeBadge) {
        badgeUrl = null;
      } else {
        badgeUrl = profile?.showcase_badge_url ?? null;
      }

      const { error } = await supabase
        .from('profiles')
        .update({
          hero_display_name: editForm.heroName.trim() || null,
          display_name: editForm.displayName.trim() || null,
          bio: editForm.bio.trim() || null,
          avatar_url: avatarUrl,
          hero_image_url: heroUrl,
          hero_theme: selectedTheme,
          showcase_badge_url: badgeUrl,
        })
        .eq('id', userId);

      if (error) {
        if (__DEV__) {
          console.error('[handleSave] Supabase profile update failed:', {
            code: error.code,
            message: error.message,
            details: error.details,
            hint: error.hint,
          });
        }
        throw new Error(
          __DEV__
            ? `Failed to save profile: ${error.message}${error.code ? ` (${error.code})` : ''}`
            : 'Failed to save profile. Please try again.'
        );
      }

      await refresh();
      setNewAvatarUri(null);
      setNewHeroUri(null);
      setRemoveHero(false);
      setNewBadgeUri(null);
      setRemoveBadge(false);
      setEditMode(false);
    } catch (e: unknown) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  const avatarUri = newAvatarUri ?? profile?.avatar_url ?? null;
  const heroUri = removeHero ? null : (newHeroUri ?? profile?.hero_image_url ?? null);
  const badgeUri = removeBadge ? null : (newBadgeUri ?? profile?.showcase_badge_url ?? null);
  const heroTheme = editMode ? selectedTheme : resolveHeroCanvasTheme(profile?.hero_theme);

  if (loading && !profile) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <View style={styles.headerSide} />
          <CacheCaseLogo variant="dark" size={35} />
          <View style={styles.headerSide} />
        </View>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerSide}>
          {editMode ? (
            <TouchableOpacity onPress={cancelEdit}>
              <Text style={styles.headerCancel}>Cancel</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={() => router.push('/settings')} hitSlop={8}>
              <IconSymbol name="gearshape.fill" size={22} color="#687076" />
            </TouchableOpacity>
          )}
        </View>
        {editMode ? (
          <Text style={styles.headerTitle}>Edit Profile</Text>
        ) : (
          <CacheCaseLogo variant="dark" size={35} />
        )}
        <View style={[styles.headerSide, styles.headerSideRight]}>
          {editMode ? (
            <TouchableOpacity onPress={handleSave} disabled={saving}>
              {saving
                ? <ActivityIndicator size="small" color="#0a7ea4" />
                : <Text style={styles.headerSave}>Save</Text>}
            </TouchableOpacity>
          ) : (
            <View style={styles.headerRightGroup}>
              <TouchableOpacity onPress={() => router.push('/saved')} hitSlop={12} activeOpacity={0.55}>
                <MaterialIcons name="bookmark-border" size={32} color="#687076" />
              </TouchableOpacity>
              <TouchableOpacity onPress={enterEdit}>
                <Text style={styles.headerEdit}>Edit</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? undefined : 'height'}>
        <Animated.ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          scrollEventThrottle={16}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true },
          )}>

          {profile && (
            <ProfileHero
              profile={profile}
              avatarUri={avatarUri}
              heroImageUri={heroUri}
              heroTheme={heroTheme}
              showcaseBadgeUri={badgeUri}
              onAvatarPress={editMode ? pickAvatar : undefined}
              onHeroPress={editMode ? pickHero : undefined}
              onBadgePress={editMode ? pickBadge : undefined}
              editMode={editMode}
              brandLabel="SHOWCASE"
              scrollY={scrollY}
              onPillPress={handlePillPress}
              activePills={['folders']}
            />
          )}

          {editMode ? (
            /* ── Edit Mode ── */
            <View style={styles.editSection}>
              <Text style={styles.fieldLabel}>Hero Name</Text>
              <TextInput
                style={styles.fieldInput}
                value={editForm.heroName}
                onChangeText={(v) => setEditForm((p) => ({ ...p, heroName: v }))}
                placeholder="Knicks Vault, Griffey Guy, The Ruler…"
                placeholderTextColor="#999"
                maxLength={40}
              />
              <Text style={styles.fieldHint}>
                Shown large in your profile hero. Leave blank to use your display name.
              </Text>
              <Text style={styles.fieldLabel}>Display Name</Text>
              <TextInput
                style={styles.fieldInput}
                value={editForm.displayName}
                onChangeText={(v) => setEditForm((p) => ({ ...p, displayName: v }))}
                placeholder="Display name"
                placeholderTextColor="#999"
                maxLength={50}
              />
              <Text style={styles.fieldLabel}>Bio</Text>
              <TextInput
                style={[styles.fieldInput, styles.bioInput]}
                value={editForm.bio}
                onChangeText={(v) => setEditForm((p) => ({ ...p, bio: v }))}
                placeholder="Tell people about yourself..."
                placeholderTextColor="#999"
                multiline
                numberOfLines={4}
                textAlignVertical="top"
                maxLength={160}
              />
              <Text style={styles.fieldLabel}>Hero Theme</Text>
              <View style={styles.themeRow}>
                {getHeroCanvasPickerThemes().map((t) => (
                  <TouchableOpacity
                    key={t.id}
                    style={[
                      styles.themeSwatch,
                      selectedTheme === t.id && styles.themeSwatchSelected,
                    ]}
                    onPress={() => setSelectedTheme(t.id)}
                    activeOpacity={0.8}>
                    {t.kind === 'image' ? (
                      <Image
                        source={t.asset.source}
                        style={styles.themeSwatchFill}
                        contentFit="cover"
                        contentPosition={t.asset.focalPoint}
                      />
                    ) : (
                      <LinearGradient
                        colors={t.swatch}
                        style={styles.themeSwatchFill}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                      />
                    )}
                    <Text style={styles.themeSwatchLabel}>{t.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ) : (
            /* ── View Mode ── */
            <>
              {/* Dark full-bleed wrapper — same near-black as the hero's own
                  tail (profile-hero.tsx's heroExtension), so it continues
                  flush with no gap. GrailsGrid itself has no background of
                  its own outside the vault, so this wrapper's color is what
                  now shows in the vault's horizontal margins and top/bottom
                  spacing, instead of the page's light background. Sized to
                  hug the card (no extra padding) — not a full-screen panel. */}
              <View style={styles.grailsSection}>
                <View style={styles.grailsTopShadow} pointerEvents="none">
                  <Svg width="100%" height="100%">
                    <Defs>
                      <RadialGradient id="grailsTopShadow" cx="50%" cy="20%" r="55%">
                        <Stop offset="0%" stopColor="#C9952C" stopOpacity={0.10} />
                        <Stop offset="100%" stopColor="#C9952C" stopOpacity={0} />
                      </RadialGradient>
                    </Defs>
                    <Rect x={0} y={0} width="100%" height="100%" fill="url(#grailsTopShadow)" />
                  </Svg>
                </View>

                <GrailsGrid
                  grails={grails}
                  editable
                  vaultMargin={24}
                  onAddFirstGrail={() => router.push('/(tabs)/collection' as any)}
                  onCabinetPress={() =>
                    router.push({
                      pathname: '/grails/[userId]',
                      params: {
                        userId: userId ?? '',
                        username: profile?.username ?? '',
                        displayName: profile?.display_name ?? '',
                      },
                    })
                  }
                />
              </View>
            </>
          )}

        </Animated.ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  headerSide: {
    flex: 1,
  },
  headerSideRight: {
    alignItems: 'flex-end',
  },
  headerRightGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#11181C',
  },
  headerCancel: {
    fontSize: 16,
    color: '#687076',
  },
  headerSave: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0a7ea4',
  },
  headerEdit: {
    fontSize: 16,
    color: '#0a7ea4',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    paddingBottom: 104,
  },
  editSection: {
    padding: 16,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#687076',
    marginTop: 16,
    marginBottom: 6,
  },
  fieldHint: {
    fontSize: 12,
    color: '#999',
    marginTop: 5,
  },
  // Exact same #000000 as profile-hero.tsx's heroExtension (not the
  // slightly lighter #0D0D0D hero root tone) — an identical flat color on
  // both sides of that boundary is what actually removes the seam, rather
  // than a merely "close" one. No padding of its own — GrailsGrid's
  // internal vaultShadow margins provide the spacing around the card.
  grailsSection: {
    backgroundColor: '#000000',
  },
  grailsTopShadow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 70,
  },
  fieldInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: '#fafafa',
    color: '#11181C',
  },
  bioInput: {
    height: 100,
    paddingTop: 12,
  },
  themeRow: {
    flexDirection: 'row',
    gap: 12,
  },
  themeSwatch: {
    alignItems: 'center',
    gap: 6,
    padding: 6,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  themeSwatchSelected: {
    borderColor: '#0a7ea4',
  },
  themeSwatchFill: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  themeSwatchLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: '#687076',
  },
});
