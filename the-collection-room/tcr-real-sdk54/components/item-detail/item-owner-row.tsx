import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

type Props = {
  username: string;
  avatarUrl: string | null;
};

// Instagram-style post header — circular avatar + @username, left-aligned,
// directly above the item's image/carousel in app/item/[id].tsx. Purely an
// identity/navigation row (taps through to the owner's public profile);
// carries no edit affordance of its own — the existing owner/edit controls
// elsewhere on the screen are untouched by this row.
export function ItemOwnerRow({ username, avatarUrl }: Props) {
  const router = useRouter();

  return (
    <Pressable
      style={styles.row}
      onPress={() => router.push({ pathname: '/user/[username]', params: { username } })}
      accessibilityRole="button"
      accessibilityLabel={`View @${username}'s profile`}>
      <View style={styles.avatar}>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
            <Text style={styles.avatarInitial}>{username.charAt(0).toUpperCase()}</Text>
          </View>
        )}
      </View>
      <Text style={styles.username} numberOfLines={1}>
        @{username}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    // Matches ItemIdentity's own paddingHorizontal (components/item-detail/
    // item-identity.tsx) — this screen's standard content inset. No
    // vertical padding/margin here — height + alignItems:'center' alone
    // center the avatar/username in the row; any vertical padding on top
    // of a fixed height would just push them off-center again.
    paddingHorizontal: 20,
    gap: 10,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#2A2A2A',
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  username: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
