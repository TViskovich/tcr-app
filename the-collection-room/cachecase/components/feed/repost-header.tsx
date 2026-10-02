import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

export type SourceOwnerAttribution = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

type Props = {
  reposterUsername: string;
  reposterDisplayName: string | null;
  reposterAvatarUrl: string | null;
  createdAt: string;
  // Omitted (no-op) in the composer preview and anywhere else tapping the
  // reposter strip shouldn't navigate — e.g. SharePostPreview, which
  // disables every touch target via its own pointerEvents="none" wrapper
  // regardless.
  onReposterPress?: () => void;
  owner: SourceOwnerAttribution;
  onOwnerPress?: () => void;
  // Owner-only "..." — rendered flush-right INSIDE the repost strip
  // (replaces a separate sibling control the caller would otherwise have
  // to lay out itself). Omitted entirely (no affordance at all) wherever
  // delete already lives elsewhere — e.g. Post Detail's own native header.
  onDeletePress?: () => void;
};

function formatAge(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Compact two-part header for a foreign-item repost ("Share → Post to Feed"
// on someone else's public card) — replaces PostCard/PostHeader's normal
// avatar+name+handle user row for exactly this case (own-item posts keep
// that row unchanged).
//
// Part 1 — the repost strip: a small, tinted, pill-like row (icon + mini
// reposter avatar + "Name reposted" + timestamp + optional "...") that
// communicates "this is a repost" at a glance without reading as its own
// separate card.
// Part 2 — the owner row: the ORIGINAL OWNER's avatar/name/handle, visually
// larger and more prominent than the strip above it, since they — not the
// reposter — are the primary identity attached to the item itself.
export function RepostHeader({
  reposterUsername,
  reposterDisplayName,
  reposterAvatarUrl,
  createdAt,
  onReposterPress,
  owner,
  onOwnerPress,
  onDeletePress,
}: Props) {
  const reposterName = reposterDisplayName || reposterUsername;
  const ownerName = owner.displayName || owner.username;

  return (
    <View style={styles.wrap}>
      <View style={styles.strip}>
        <IconSymbol name="arrow.2.squarepath" size={13} color={PV2.link} />

        <TouchableOpacity
          style={styles.stripTouch}
          onPress={onReposterPress}
          disabled={!onReposterPress}
          activeOpacity={0.7}
          accessibilityRole={onReposterPress ? 'button' : undefined}>
          <View style={styles.stripAvatar}>
            {reposterAvatarUrl ? (
              <Image source={{ uri: reposterAvatarUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
            ) : (
              <View style={[StyleSheet.absoluteFill, styles.stripAvatarPlaceholder]}>
                <Text style={styles.stripAvatarInitial}>{reposterName.charAt(0).toUpperCase()}</Text>
              </View>
            )}
          </View>
          <Text style={styles.stripText} numberOfLines={1}>
            <Text style={styles.stripName}>{reposterName}</Text>
            <Text style={styles.stripVerb}> reposted</Text>
          </Text>
        </TouchableOpacity>

        <Text style={styles.stripDate}>{formatAge(createdAt)}</Text>

        {onDeletePress && (
          <TouchableOpacity
            onPress={onDeletePress}
            hitSlop={10}
            style={styles.stripMoreBtn}
            accessibilityRole="button"
            accessibilityLabel="Post options">
            <IconSymbol name="ellipsis" size={15} color="rgba(255,255,255,0.5)" />
          </TouchableOpacity>
        )}
      </View>

      <TouchableOpacity
        style={styles.ownerRow}
        onPress={onOwnerPress}
        disabled={!onOwnerPress}
        activeOpacity={0.7}
        accessibilityRole={onOwnerPress ? 'button' : undefined}
        accessibilityLabel={`${ownerName}, original owner`}>
        <View style={styles.avatar}>
          {owner.avatarUrl ? (
            <Image source={{ uri: owner.avatarUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
              <Text style={styles.avatarInitial}>{ownerName.charAt(0).toUpperCase()}</Text>
            </View>
          )}
        </View>
        <View style={styles.identityLine}>
          <Text style={styles.ownerName} numberOfLines={1}>
            {ownerName}
          </Text>
          <Text style={styles.ownerUsername} numberOfLines={1}>
            @{owner.username}
          </Text>
        </View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  // No padding of its own — the strip and owner row below each own their
  // own horizontal inset (marginHorizontal / paddingHorizontal), matching
  // PostCard's cardHeader paddingHorizontal (12) so both sit flush with
  // every other post's identity row despite this being two stacked rows
  // instead of one.
  wrap: {
    gap: 8,
  },
  // Compact, subtly tinted pill — communicates "repost" immediately
  // without reading as a second, separate card. Tint reuses PV2.link
  // (already this app's "link/accent-blue" token) at low opacity rather
  // than introducing a new color.
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginHorizontal: 12,
    marginTop: 10,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 9,
    backgroundColor: 'rgba(90,169,240,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(90,169,240,0.18)',
  },
  stripTouch: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stripAvatar: {
    width: 18,
    height: 18,
    borderRadius: 9,
    overflow: 'hidden',
    backgroundColor: PV2.emptyCardBg,
    flexShrink: 0,
  },
  stripAvatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  stripAvatarInitial: {
    fontSize: 9,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  stripText: {
    flexShrink: 1,
  },
  stripName: {
    fontSize: 12,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  stripVerb: {
    fontSize: 12,
    color: PV2.textTertiary,
  },
  stripDate: {
    fontSize: 11,
    color: PV2.textTertiary,
    flexShrink: 0,
  },
  stripMoreBtn: {
    paddingLeft: 6,
  },
  // Original owner — the primary identity, deliberately larger/stronger
  // than the strip's mini avatar/text above it.
  ownerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    // Matches cardHeader's own paddingBottom (4) in the normal, non-repost
    // header — same gap before the caption/media that follows, whichever
    // header rendered.
    paddingBottom: 4,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: PV2.emptyCardBg,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 15,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  identityLine: {
    flexShrink: 1,
  },
  ownerName: {
    fontSize: 15,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  ownerUsername: {
    fontSize: 12,
    color: PV2.textTertiary,
  },
});
