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

import { Stack, useRouter } from 'expo-router';

import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

const MAX_CHARS = 280;

export default function NewPostScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

  const charCount = text.length;
  const canPost = text.trim().length > 0 && charCount <= MAX_CHARS && !posting;

  async function handlePost() {
    if (!canPost || !session?.user?.id) return;
    setPosting(true);
    const { error } = await supabase.from('posts').insert({
      user_id: session.user.id,
      post_type: 'text',
      content: text.trim(),
    });
    if (error) {
      Alert.alert('Post failed', error.message);
      setPosting(false);
      return;
    }
    router.back();
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: 'New Post',
          headerLeft: () => (
            <TouchableOpacity onPress={() => router.back()} hitSlop={8}>
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

      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
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
});
