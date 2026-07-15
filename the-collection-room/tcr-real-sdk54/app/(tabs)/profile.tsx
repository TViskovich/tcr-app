import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  type AlertButton,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ProfileV2CollectorPanel, type PrototypeCollectorStats } from '@/components/profile-v2/profile-v2-collector-panel';
import { ProfileV2Collections } from '@/components/profile-v2/profile-v2-collections';
import { ProfileV2Grid } from '@/components/profile-v2/profile-v2-grid';
import { ProfileV2Hero } from '@/components/profile-v2/profile-v2-hero';
import { ProfileV2Identity } from '@/components/profile-v2/profile-v2-identity';
import { ProfileV2SectionPage } from '@/components/profile-v2/profile-v2-section-page';
import { ProfileV2Selector, type ProfileV2Section } from '@/components/profile-v2/profile-v2-selector';
import { ProfileV2Stats } from '@/components/profile-v2/profile-v2-stats';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import {
  getHeroCanvasPickerThemes,
  HERO_CANVAS_THEMES,
  resolveHeroCanvasTheme,
  type HeroCanvasThemeId,
} from '@/components/profile/hero-canvas-themes';
import { useFolders } from '@/hooks/use-collection';
import { useProfile } from '@/hooks/use-profile';
import { useGrails } from '@/hooks/use-grails';
import { useAuth } from '@/lib/auth';
import { uploadAvatar, uploadBadgeImage, uploadHeroImage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';

// Values with no corresponding column/table yet (see PrototypeCollectorStats
// in profile-v2-collector-panel.tsx). Kept in exactly one place, clearly
// named, rather than inlined in JSX — swap these out if/when the real data
// lands (an authentications table, an ownership-transfer history, a
// collector registry id).
const prototypeCollectorStats: PrototypeCollectorStats = {
  authenticated: 0,
  transferred: 0,
  collectorId: 'CCA #1',
};

export default function ProfileScreen() {
  const { session } = useAuth();
  const userId = session?.user?.id;
  const router = useRouter();
  const { profile, stats, loading, refresh } = useProfile(userId);
  const { grails, refresh: refreshGrails } = useGrails(userId);
  const { folders, refresh: refreshFolders } = useFolders(userId);

  const [section, setSection] = useState<ProfileV2Section>('cachecase');
  // Measured once off the cachecase section's real rendered height (see
  // ProfileV2SectionPage below) — cachecase is both the default tab and the
  // tallest, so this captures a real "Grails" dimension rather than a
  // hardcoded guess, with no visible flash since it's measured before the
  // user can switch to a shorter section.
  const [sectionMinHeight, setSectionMinHeight] = useState<number | undefined>(undefined);

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
      refreshFolders();
    }, [refresh, refreshGrails, refreshFolders]),
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
  const themeDef = HERO_CANVAS_THEMES.find((t) => t.id === heroTheme);
  const themeFallbackSwatch: [string, string] =
    themeDef?.kind === 'procedural' ? themeDef.swatch : ['#1C1C1E', '#0A0A0C'];

  if (loading && !profile) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.accent} />
        </View>
      </SafeAreaView>
    );
  }

  const displayName = profile?.hero_display_name || profile?.display_name || profile?.username || '';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? undefined : 'height'}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          showsVerticalScrollIndicator={false}>

          {profile && (
            <ProfileV2Hero
              avatarUri={avatarUri}
              heroImageUri={heroUri}
              themeFallbackSwatch={themeFallbackSwatch}
              displayName={displayName}
              username={profile?.username ?? ''}
              editMode={editMode}
              saving={saving}
              onAvatarPress={editMode ? pickAvatar : undefined}
              onHeroPress={editMode ? pickHero : undefined}
              onSettingsPress={() => router.push('/settings')}
              onSavedPress={() => router.push('/saved')}
              onCancelPress={cancelEdit}
              onSavePress={handleSave}
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
                placeholderTextColor="rgba(255,255,255,0.35)"
                maxLength={40}
              />
              <Text style={styles.fieldHint}>
                Shown large on your profile. Leave blank to use your display name.
              </Text>
              <Text style={styles.fieldLabel}>Display Name</Text>
              <TextInput
                style={styles.fieldInput}
                value={editForm.displayName}
                onChangeText={(v) => setEditForm((p) => ({ ...p, displayName: v }))}
                placeholder="Display name"
                placeholderTextColor="rgba(255,255,255,0.35)"
                maxLength={50}
              />
              <Text style={styles.fieldLabel}>Bio</Text>
              <TextInput
                style={[styles.fieldInput, styles.bioInput]}
                value={editForm.bio}
                onChangeText={(v) => setEditForm((p) => ({ ...p, bio: v }))}
                placeholder="Tell people about yourself..."
                placeholderTextColor="rgba(255,255,255,0.35)"
                multiline
                numberOfLines={4}
                textAlignVertical="top"
                maxLength={160}
              />
              <TouchableOpacity style={styles.badgeEditRow} onPress={pickBadge} activeOpacity={0.8}>
                <View style={styles.badgeEditPreview}>
                  {badgeUri ? (
                    <Image source={{ uri: badgeUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
                  ) : null}
                </View>
                <Text style={styles.badgeEditLabel}>
                  {badgeUri ? 'Change Collector Badge' : 'Add Collector Badge'}
                </Text>
              </TouchableOpacity>
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
              <ProfileV2Identity
                bio={profile?.bio ?? null}
                mode="owner"
                onEditPress={enterEdit}
              />

              <ProfileV2Stats followers={stats.followerCount} following={stats.followingCount} />

              <ProfileV2Selector active={section} onChange={setSection} />

              {/* One shared, fixed-minHeight container for whichever section
                  is active — measured once off the cachecase section (the
                  tallest: collector panel + Grails grid), since that's the
                  default/starting tab. Shorter sections (posts/transfers/
                  bookmarked/collections) then hold the same floor instead of
                  shrinking the page and shifting everything below it. */}
              <ProfileV2SectionPage
                minHeight={sectionMinHeight}
                onLayout={(e) => {
                  if (section === 'cachecase' && sectionMinHeight === undefined) {
                    setSectionMinHeight(e.nativeEvent.layout.height);
                  }
                }}>
                {section === 'posts' && (
                  <View style={styles.sectionEmpty}>
                    <Text style={styles.sectionEmptyText}>Posts coming soon.</Text>
                  </View>
                )}

                {section === 'cachecase' && (
                  <>
                    <ProfileV2CollectorPanel
                      avatarUri={avatarUri}
                      displayName={displayName}
                      username={profile?.username ?? ''}
                      vaultTotal={stats.itemCount}
                      graded={stats.gradedCount}
                      prototype={prototypeCollectorStats}
                      badgeUri={badgeUri}
                    />
                    <ProfileV2Grid
                      grails={grails}
                      onItemPress={(item) =>
                        router.push({ pathname: '/item/[id]', params: { id: item.item_id, fromGrails: '1' } })
                      }
                      onAddPress={() => router.push('/(tabs)/collection' as any)}
                    />
                  </>
                )}

                {section === 'collections' && (
                  <ProfileV2Collections
                    folders={folders}
                    onFolderPress={(folder) =>
                      router.push({ pathname: '/folder/[id]', params: { id: folder.id, name: folder.name } })
                    }
                    onCreatePress={() => router.push('/(tabs)/collection' as any)}
                  />
                )}

                {section === 'transfers' && (
                  <View style={styles.sectionEmpty}>
                    <Text style={styles.sectionEmptyText}>Transfers coming soon.</Text>
                  </View>
                )}

                {section === 'bookmarked' && (
                  <View style={styles.sectionEmpty}>
                    <Text style={styles.sectionEmptyText}>Bookmarked coming soon.</Text>
                  </View>
                )}
              </ProfileV2SectionPage>
            </>
          )}

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    paddingBottom: 120,
  },
  editSection: {
    padding: 16,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: PV2.textSecondary,
    marginTop: 16,
    marginBottom: 6,
  },
  fieldHint: {
    fontSize: 12,
    color: PV2.textTertiary,
    marginTop: 5,
  },
  fieldInput: {
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: PV2.panel,
    color: '#fff',
  },
  bioInput: {
    height: 100,
    paddingTop: 12,
  },
  badgeEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 20,
  },
  badgeEditPreview: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  badgeEditLabel: {
    color: PV2.link,
    fontSize: 14,
    fontWeight: '600',
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
    borderColor: PV2.accent,
  },
  themeSwatchFill: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  themeSwatchLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: PV2.textSecondary,
  },
  // Shared "coming soon" placeholder for sections with no real data source
  // yet (posts, transfers, bookmarked) — cachecase/collections render real
  // content instead.
  sectionEmpty: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  sectionEmptyText: {
    color: PV2.textTertiary,
    fontSize: 14,
  },
});
