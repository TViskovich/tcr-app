import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { IconSymbol } from '@/components/ui/icon-symbol';

import { formatWebsiteLabel, getSafeWebsiteUrl, openWebsite } from './profile-v2-identity';
import { ProfileV2FollowMenu } from './profile-v2-follow-menu';
import { ProfileV2Stats } from './profile-v2-stats';
import { PV2 } from './profile-v2-theme';

type Props = {
  // All sourced from the same `profile`/`stats` the compact header and the
  // (unreachable, pre-Profile-V3) ProfileV2Identity/ProfileV2Stats section
  // already read — no new query, no new field.
  location: string | null;
  bio: string | null;
  collectingCategories: string[];
  website: string | null;
  followers: number;
  following: number;
  mode: 'owner' | 'public';
  onEditPress?: () => void;
  onToggleFollow?: () => void;
  onMessagePress?: () => void;
  isFollowing?: boolean;
  followLoading?: boolean;
  messageLoading?: boolean;
  onSharePress: () => void;
  // Opens the dedicated Followers/Following list screens for whichever
  // profile this panel belongs to (see profile-v2-screen.tsx) — always the
  // profile being VIEWED, never automatically the signed-in viewer.
  onFollowersPress?: () => void;
  onFollowingPress?: () => void;
};

// The panel that opens beneath ProfileV2IdentityCard when it's tapped (see
// profile-v2-screen.tsx's `detailsExpanded` state). Reuses the exact same
// profile fields and follow/message/edit-profile handlers the old
// (unreachable) `section === 'cachecase'` ProfileV2Identity/ProfileV2Stats
// pairing already wired up — this is a new layout over that same data, not
// a new data source or a new follow/message implementation.
//
// Top-row refinement pass: the standalone person+pencil Edit Profile icon
// is gone — the owner now reaches enterEdit() by tapping "..." directly
// (no intermediate menu/dropdown — a dropdown was tried in an earlier pass
// and explicitly rejected: a single owner action doesn't need one extra
// tap in front of it), sitting next to Share on the right. Location sits
// on that same top row (left side), matching the reference layout.
export function ProfileV2ExpandedDetails({
  location,
  bio,
  collectingCategories,
  website,
  followers,
  following,
  mode,
  onEditPress,
  onToggleFollow,
  onMessagePress,
  isFollowing,
  followLoading,
  messageLoading,
  onSharePress,
  onFollowersPress,
  onFollowingPress,
}: Props) {
  const safeWebsiteUrl = website ? getSafeWebsiteUrl(website) : null;

  return (
    <View style={styles.wrap}>
      <View style={styles.topRow}>
        <View style={styles.locationGroup}>
          {location ? (
            <>
              <IconSymbol name="mappin" size={13} color={PV2.textTertiary} />
              <Text style={styles.location}>{location}</Text>
            </>
          ) : null}
        </View>

        <View style={styles.topRightIcons}>
          {/* Owner-only, direct tap straight into the existing enterEdit()
              flow — no menu/dropdown/popup in front of it. Never rendered
              for a visitor (no existing profile-options feature exists for
              another user's profile to put here instead). */}
          {mode === 'owner' && onEditPress && (
            <TouchableOpacity
              onPress={onEditPress}
              style={styles.ellipsisBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Edit profile">
              <IconSymbol name="ellipsis" size={24} color={PV2.textSecondary} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={onSharePress}
            style={styles.shareBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Share profile">
            <IconSymbol name="square.and.arrow.up" size={24} color={PV2.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {bio ? <Text style={styles.bio}>{bio}</Text> : null}

      {collectingCategories.length > 0 ? (
        <Text style={styles.collecting}>
          Currently collecting:{' '}
          <Text style={styles.collectingHighlight}>{collectingCategories.join(', ')}</Text>
        </Text>
      ) : null}

      {website ? (
        safeWebsiteUrl ? (
          <Text
            style={styles.website}
            onPress={() => openWebsite(safeWebsiteUrl)}
            accessibilityRole="link"
            accessibilityLabel={`Open website: ${formatWebsiteLabel(safeWebsiteUrl)}`}>
            {formatWebsiteLabel(safeWebsiteUrl)}
          </Text>
        ) : (
          <Text style={styles.websiteInvalid}>{website}</Text>
        )
      ) : null}

      <ProfileV2Stats
        followers={followers}
        following={following}
        onFollowersPress={onFollowersPress}
        onFollowingPress={onFollowingPress}
      />

      {mode === 'public' && (
        <View style={styles.actionsRow}>
          <ProfileV2FollowMenu
            isFollowing={!!isFollowing}
            loading={followLoading}
            onToggleFollow={onToggleFollow ?? (() => {})}
          />
          <TouchableOpacity
            style={styles.messageBtn}
            onPress={onMessagePress}
            disabled={messageLoading}
            activeOpacity={0.85}>
            <Text style={styles.messageBtnLabel}>Message</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Same 20px horizontal inset as ProfileV2IdentityCard's own
  // CARD_HORIZONTAL_PADDING, and the same PV2.bg the rest of the screen
  // uses — this panel reads as part of the header, not a separate card.
  wrap: {
    backgroundColor: PV2.bg,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 14,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  locationGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  location: {
    color: PV2.textTertiary,
    fontSize: 12,
  },
  // Groups "..." (owner only) and Share so they sit together as one
  // right-aligned cluster — adding/removing the owner-only "..." changes
  // this group's own width, not its right edge.
  topRightIcons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Same 40px touch target / centered-24px-glyph spec as `shareBtn` below —
  // the two read as a matched pair.
  ellipsisBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Primary text, not secondary — the bio is the panel's main line of
  // content, everything else here is metadata around it.
  bio: {
    color: PV2.textPrimary,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 10,
  },
  // Larger gap from bio (16, vs. bio's own 10 from the top row) — this is
  // deliberately bigger than the other inter-section gaps so "Currently
  // collecting" reads as its own metadata section rather than a second
  // line of the bio.
  collecting: {
    color: PV2.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 16,
  },
  // Same accent as `website` below — the app's one existing non-destructive
  // "notable/tappable" text color (already used for website links
  // elsewhere), reused here rather than inventing a new one-off color.
  collectingHighlight: {
    color: PV2.link,
    fontWeight: '600',
  },
  // Smaller, tighter gap from `collecting` above (9) than `collecting`'s
  // own gap from bio — website reads as directly associated with the
  // collecting line above it, not a third independent section.
  website: {
    color: PV2.link,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 9,
  },
  websiteInvalid: {
    color: PV2.textTertiary,
    fontSize: 13,
    marginTop: 9,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  // Matches ProfileV2FollowMenu's own actionBtn spec exactly (subtle
  // border, dark translucent fill, rounded, compact) — the two sit side by
  // side and must read as one matched pair.
  messageBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: PV2.border,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageBtnLabel: {
    color: PV2.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
});
