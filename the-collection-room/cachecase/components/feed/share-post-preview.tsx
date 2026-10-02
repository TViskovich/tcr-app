import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PostCard, type FeedPost, type SourceOwnerAttribution } from '@/components/feed/post-card';
import type { CardShareItem } from '@/types';

type Props = {
  avatarUrl: string | null;
  displayName: string;
  username: string;
  caption: string;
  cards: CardShareItem[];
  // Foreign-repost preview only ("Post to Feed" on someone else's public
  // card, see app/share-card/new.tsx's own isForeignRepost) — when set,
  // this preview renders a single-item 'item' FeedPost with the repost
  // attribution header instead of the normal 'card_share' carousel post,
  // so the composer stays genuinely WYSIWYG with the two different posts
  // this screen can actually create. Ignored (the existing card_share
  // preview renders) when omitted — every other call site (Share Card's
  // own multi-card compose) is unaffected.
  itemPost?: {
    imageUrl: string | null;
    // Matches the single item_name fallback string a real 'item' post's
    // caption falls back to at read time (post.caption || post.item_name —
    // see post-card.tsx's fetchUserPosts/app/(tabs)/index.tsx's queryFeed)
    // — not a separate title+subtitle pair, since the real post never
    // stores or shows both.
    title: string | null;
    sourceOwner: SourceOwnerAttribution | null;
  };
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
export function SharePostPreview({ avatarUrl, displayName, username, caption, cards, itemPost }: Props) {
  const [createdAt] = useState(() => new Date().toISOString());

  if (!itemPost && cards.length === 0) return null;

  const post: FeedPost = itemPost
    ? {
        id: 'preview',
        user_id: '',
        post_type: 'item',
        item_id: null,
        image_url: itemPost.imageUrl,
        content: null,
        caption: caption.trim() || null,
        created_at: createdAt,
        item_name: itemPost.title,
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
        cardShareItems: [],
        images: [],
        sourceOwner: itemPost.sourceOwner,
      }
    : {
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
