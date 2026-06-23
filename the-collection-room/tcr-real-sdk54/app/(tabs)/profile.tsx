import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { useProfile } from '@/hooks/use-profile';
import { useAuth } from '@/lib/auth';
import { uploadAvatar } from '@/lib/storage';
import { supabase } from '@/lib/supabase';

export default function ProfileScreen() {
  const { session } = useAuth();
  const userId = session?.user?.id;
  const router = useRouter();
  const { profile, stats, loading, refresh } = useProfile(userId);

  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState({ displayName: '', bio: '' });
  const [newAvatarUri, setNewAvatarUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  function enterEdit() {
    setEditForm({
      displayName: profile?.display_name ?? '',
      bio: profile?.bio ?? '',
    });
    setNewAvatarUri(null);
    setEditMode(true);
  }

  function cancelEdit() {
    setNewAvatarUri(null);
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

      const { error } = await supabase
        .from('profiles')
        .update({
          display_name: editForm.displayName.trim() || null,
          bio: editForm.bio.trim() || null,
          avatar_url: avatarUrl,
        })
        .eq('id', userId);

      if (error) throw new Error('Failed to save profile. Please try again.');

      await refresh();
      setNewAvatarUri(null);
      setEditMode(false);
    } catch (e: unknown) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  const displayName = profile?.display_name || profile?.username || 'User';
  const avatarUri = newAvatarUri ?? profile?.avatar_url ?? null;

  if (loading && !profile) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <View style={styles.headerSide} />
          <Text style={styles.headerTitle}>Profile</Text>
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
        <Text style={styles.headerTitle}>{editMode ? 'Edit Profile' : 'Profile'}</Text>
        <View style={[styles.headerSide, styles.headerSideRight]}>
          {editMode ? (
            <TouchableOpacity onPress={handleSave} disabled={saving}>
              {saving
                ? <ActivityIndicator size="small" color="#0a7ea4" />
                : <Text style={styles.headerSave}>Save</Text>}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={enterEdit}>
              <Text style={styles.headerEdit}>Edit</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled">

          {/* Avatar */}
          <Pressable
            onPress={editMode ? pickAvatar : undefined}
            style={styles.avatarWrap}>
            {avatarUri ? (
              <Image
                source={{ uri: avatarUri }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
              />
            ) : (
              <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
                <Text style={styles.avatarInitial}>
                  {displayName.charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
            {editMode && (
              <View style={styles.avatarOverlay}>
                <Text style={styles.avatarOverlayText}>Change</Text>
              </View>
            )}
          </Pressable>

          {editMode ? (
            /* ── Edit Mode ── */
            <View style={styles.editSection}>
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
            </View>
          ) : (
            /* ── View Mode ── */
            <>
              <View style={styles.viewSection}>
                <Text style={styles.displayName}>{displayName}</Text>
                <Text style={styles.usernameText}>@{profile?.username}</Text>
                {profile?.bio ? (
                  <Text style={styles.bio}>{profile.bio}</Text>
                ) : null}
              </View>

              <View style={styles.statsRow}>
                <View style={styles.stat}>
                  <Text style={styles.statNumber}>{stats.folderCount}</Text>
                  <Text style={styles.statLabel}>Folders</Text>
                </View>
                <View style={styles.statDivider} />
                <View style={styles.stat}>
                  <Text style={styles.statNumber}>{stats.itemCount}</Text>
                  <Text style={styles.statLabel}>Items</Text>
                </View>
                <View style={styles.statDivider} />
                <View style={styles.stat}>
                  <Text style={styles.statNumber}>{stats.postCount}</Text>
                  <Text style={styles.statLabel}>Posts</Text>
                </View>
                <View style={styles.statDivider} />
                <View style={styles.stat}>
                  <Text style={styles.statNumber}>{stats.followerCount}</Text>
                  <Text style={styles.statLabel}>Followers</Text>
                </View>
                <View style={styles.statDivider} />
                <View style={styles.stat}>
                  <Text style={styles.statNumber}>{stats.followingCount}</Text>
                  <Text style={styles.statLabel}>Following</Text>
                </View>
              </View>
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
    width: 64,
  },
  headerSideRight: {
    alignItems: 'flex-end',
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
    paddingBottom: 48,
  },
  avatarWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignSelf: 'center',
    marginTop: 28,
    marginBottom: 16,
    overflow: 'hidden',
    backgroundColor: '#E3F2FD',
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 36,
    fontWeight: '700',
    color: '#1565C0',
  },
  avatarOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarOverlayText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  viewSection: {
    alignItems: 'center',
    paddingHorizontal: 24,
    gap: 4,
  },
  displayName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#11181C',
  },
  usernameText: {
    fontSize: 14,
    color: '#687076',
  },
  bio: {
    fontSize: 14,
    color: '#444',
    textAlign: 'center',
    lineHeight: 20,
    marginTop: 4,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 28,
    paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  stat: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  statNumber: {
    fontSize: 20,
    fontWeight: '700',
    color: '#11181C',
  },
  statLabel: {
    fontSize: 12,
    color: '#687076',
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    height: 32,
    backgroundColor: '#e0e0e0',
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
});
