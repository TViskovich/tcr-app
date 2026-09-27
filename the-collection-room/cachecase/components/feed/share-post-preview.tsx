import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PostCard, type FeedPost } from '@/components/feed/post-card';
import type { CardShareItem } from '@/types';

type Props = {
  avatarUrl: string | null;
  displayName: string;
  username: string;
  caption: string;
  cards: CardShareItem[];
};

// "What this will look like in Feed" preview for the Share Card compose flow
// (app/share-card/new.tsx). Renders the REAL PostCard with a card_share
// FeedPost built from the current user's real profile, the selected cards
// (real titles/subtitles and their already-signed images) and the typed
// caption — so header, media frame/aspect ratio, crop, radius, caption
// placement and engagement row are the published post's own, by
// construction, not a parallel approximation.
//
// Preview-only: pointerEvents="none" disables every touch target (profile,
// post, like, comment, carousel-slide navigation), all handlers are no-ops,
// and currentUserId is left undefined so the owner-only options menu never
// renders. No post exists yet, so id/user_id are placeholders, counts are 0
// and the timestamp is "now".
export function SharePostPreview({ avatarUrl, displayName, username, caption, cards }: Props) {
  const [createdAt] = useState(() => new Date().toISOString());

  if (cards.length === 0) return null;

  const post: FeedPost = {
    id: 'preview',
    user_id: '',
    post_type: 'card_share',
    image_url: null,
    content: null,
    caption: caption.trim() || null,
    created_at: createdAt,
    item_name: null,
    username,
    display_name: displayName || null,
    avatar_url: avatarUrl,
    likeCount: 0,
    liked: false,
    commentCount: 0,
    isFollowing: false,
    grailCards: [],
    avgRating: null,
    ratingCount: 0,
    myRating: null,
    cardShareItems: cards,
    images: [],
  };

  return (
    <View style={styles.bleed} pointerEvents="none">
      <PostCard
        post={post}
        currentUserId={undefined}
        onUserPress={noop}
        onPostPress={noop}
        onCommentPress={noop}
        onLike={noop}
      />
    </View>
  );
}

function noop() {}

const styles = StyleSheet.create({
  // The Feed card is full screen width; this screen's scroll content is
  // inset 16px each side (styles.scroll padding), which would make the media
  // 32px narrower than the published post. Cancel that inset so the card
  // gets the same width — and therefore the same media size — as in Feed.
  bleed: {
    marginHorizontal: -16,
  },
});
