import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { copyPostPhotoToShareSnapshots } from '@/lib/share-snapshots';
import { uploadItemImage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';

const MAX_CHARS = 280;

export default function NewPostScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  // A create form, not a scrollable browsing list — no scroll-hide effect,
  // but still resets the shared navbar to visible on focus.
  useScrollResponsiveNavbar({ enabled: false });
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  // Local picker URI only — nothing is uploaded until Post is actually
  // tapped, same "stage now, persist on submit" convention as every other
  // image field in this app (see profile-v2-screen.tsx's Edit Profile
  // avatar/hero staging).
  const [imageUri, setImageUri] = useState<string | null>(null);

  const charCount = text.length;
  const canPost = text.trim().length > 0 && charCount <= MAX_CHARS && !posting;

  // Same permission + picker call as app/item/new.tsx's own photo picker —
  // no forced crop (allowsEditing: false), since a post photo should keep
  // its natural shape (post-card.tsx's responsive single-image renderer
  // already handles arbitrary aspect ratios). Reused, not reinvented.
  async function pickPhoto() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setImageUri(result.assets[0].uri);
    }
  }

  function removePhoto() {
    setImageUri(null);
  }

  // No back history when this screen was deep-linked, reloaded directly, or
  // opened during development — fall back to the main feed, where the Create
  // menu that opens this screen always lives and where the new post appears.
  function leaveScreen() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  async function handlePost() {
    if (!canPost || !session?.user?.id) return;
    setPosting(true);

    // Two steps, both before the posts insert (never insert first and
    // best-effort-upgrade after — same rule copyPostPhotoToShareSnapshots'
    // own doc comment documents, for the same reason): (1) stage the photo
    // via the same item-images upload path every other free-form photo
    // upload in this app already goes through (app/item/new.tsx), then
    // (2) copy it server-side into the durable, always-public
    // share-snapshots bucket — the same surface every other post image
    // already renders from — via a dedicated Edge Function (there's no
    // collection_items row behind a plain text post's photo, so the
    // existing item-scoped copy-share-snapshot-image can't be reused
    // as-is). If either step fails, no post row is created at all, and the
    // draft/selected photo are left exactly as the user had them.
    let uploadedImageUrl: string | null = null;
    if (imageUri) {
      let stagedUrl: string;
      try {
        stagedUrl = await uploadItemImage(imageUri, session.user.id);
      } catch {
        Alert.alert('Post failed', 'Image upload failed. Check your connection and try again.');
        setPosting(false);
        return;
      }

      const copyResult = await copyPostPhotoToShareSnapshots(stagedUrl);
      if (copyResult.status !== 'ok') {
        Alert.alert('Post failed', 'Image processing failed. Check your connection and try again.');
        setPosting(false);
        return;
      }
      uploadedImageUrl = copyResult.publicUrl;
    }

    const { error } = await supabase.from('posts').insert({
      user_id: session.user.id,
      post_type: 'text',
      content: text.trim(),
      // Omitted entirely (not `image_url: null`) when there's no photo —
      // identical insert payload to before this feature existed, so a
      // text-only post behaves exactly as it always has.
      ...(uploadedImageUrl ? { image_url: uploadedImageUrl } : {}),
    });
    if (error) {
      Alert.alert('Post failed', error.message);
      setPosting(false);
      return;
    }
    leaveScreen();
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: 'New Post',
          headerLeft: () => (
            <TouchableOpacity onPress={leaveScreen} hitSlop={8}>
              <Text style={styles.headerCancel}>Cancel</Text>
            </TouchableOpacity>
          ),
          headerRight: () => (
            <TouchableOpacity onPress={handlePost} disabled={!canPost} hitSlop={8}>
              {posting ? (
                <ActivityIndicator size="small" color="#0a7ea4" />
              ) : (
                <Text style={[styles.headerPost, !canPost && styles.headerPostDisabled]}>
                  Post
                </Text>
              )}
            </TouchableOpacity>
          ),
        }}
      />

      {/* keyboardVerticalOffset — same insets.top + 44 (standard iOS nav-bar
          height) pattern already used by app/post/[id].tsx and
          app/conversation/[id].tsx for this exact screen shape (a Stack
          header above a KeyboardAvoidingView). Without it, "padding"
          behavior undershoots by the header's own height, since the
          native Stack header isn't part of this view's own measured
          frame — that undershoot is exactly why the Add Photo/preview
          control (below the text input) was ending up hidden under the
          keyboard. Not a hardcoded keyboard height: 44 is the header,
          insets.top is the safe-area/notch inset above it. */}
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}>
        <TextInput
          style={styles.input}
          placeholder="What are you collecting?"
          placeholderTextColor="#999"
          multiline
          autoFocus
          value={text}
          onChangeText={setText}
          maxLength={MAX_CHARS}
          textAlignVertical="top"
        />

        {imageUri ? (
          <View style={styles.photoPreviewWrap}>
            <View style={styles.photoPreviewBox}>
              <TouchableOpacity
                onPress={pickPhoto}
                activeOpacity={0.9}
                style={StyleSheet.absoluteFill}
                accessibilityRole="button"
                accessibilityLabel="Replace photo">
                <Image source={{ uri: imageUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={removePhoto}
                hitSlop={8}
                style={styles.photoRemoveBtn}
                accessibilityRole="button"
                accessibilityLabel="Remove photo">
                <IconSymbol name="xmark" size={14} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity
            onPress={pickPhoto}
            style={styles.addPhotoBtn}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="Add photo">
            <IconSymbol name="camera.fill" size={18} color="#0a7ea4" />
            <Text style={styles.addPhotoLabel}>Add Photo</Text>
          </TouchableOpacity>
        )}

        <View style={styles.footer}>
          <Text
            style={[
              styles.counter,
              charCount >= MAX_CHARS - 30 && styles.counterAmber,
              charCount >= MAX_CHARS && styles.counterRed,
            ]}>
            {charCount}/{MAX_CHARS}
          </Text>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  headerCancel: {
    fontSize: 16,
    color: '#687076',
  },
  headerPost: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0a7ea4',
  },
  headerPostDisabled: {
    color: '#ccc',
  },
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  input: {
    flex: 1,
    fontSize: 17,
    color: '#11181C',
    padding: 16,
    lineHeight: 24,
  },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'flex-end',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },
  counter: {
    fontSize: 13,
    color: '#aaa',
  },
  counterAmber: {
    color: '#F59E0B',
  },
  counterRed: {
    color: '#E53935',
  },
  addPhotoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  addPhotoLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0a7ea4',
  },
  photoPreviewWrap: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  photoPreviewBox: {
    width: 120,
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#eee',
  },
  photoRemoveBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
