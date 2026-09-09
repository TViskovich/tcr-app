import { ActivityIndicator, Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { PV2 } from './profile-v2-theme';

// Identity Header — display name, username, action row, tagline, bio,
// location, website, member-since. No longer renders an avatar: the
// Collector Panel avatar (components/profile-v2/profile-v2-collector-
// panel.tsx) is the profile's sole avatar and its owner-only tap target
// (wired in profile-v2-screen.tsx via pickAvatar), so avatar
// presentation/editing was removed from here rather than duplicated.
//
// mode is 'owner' for the signed-in user's own profile, 'public' when
// viewing someone else's (components/profile-v2/profile-v2-screen.tsx,
// shared by both app/(tabs)/profile.tsx and app/user/[username].tsx).
// Identity/preference data itself is identical for owner and visitor —
// only the action row (Edit vs. Follow/Message) differs by mode.
type Props = {
  displayName: string;
  username: string;
  // All three default true (full render). Each gates one independent
  // block: showHeader is name/username only, showActions is the action
  // row (Edit Profile / Follow+Message) only, showDetails is tagline
  // through member-since. profile-v2-screen.tsx composes these
  // differently per branch — see that file's ProfileV2HeroCanvas
  // identityHeader wiring and the below-canvas call site.
  showHeader?: boolean;
  showActions?: boolean;
  showDetails?: boolean;
  tagline?: string | null;
  bio: string | null;
  location?: string | null;
  // website is normalized at save time (profile-v2-screen.tsx's
  // normalizeWebsiteInput), but re-validated here too before ever being
  // rendered as tappable — defense in depth against a value that reached
  // the database some other way.
  website?: string | null;
  // profile.created_at — same value for owner and visitor, no separate
  // query. Rendered as "Member since <Month> <Year>" via
  // formatMemberSince below; omitted entirely (never "Invalid Date") for
  // a missing or unparseable value.
  createdAt?: string | null;
  mode: 'owner' | 'public';
  onEditPress?: () => void;
  onFollowPress?: () => void;
  onMessagePress?: () => void;
  isFollowing?: boolean;
  followLoading?: boolean;
  messageLoading?: boolean;
};

// Deliberately does NOT use `new URL(...)` — React Native's actual global
// URL (node_modules/react-native/Libraries/Blob/URL.js, registered by
// Libraries/Core/setUpXHR.js) is a small regex-based shim, not a
// spec-compliant WHATWG implementation: its constructor never throws for
// malformed input when called without a `base` argument, so a
// try/catch-around-`new URL()` pattern (which works fine under Node,
// where this was first drafted and tested) is silently dead code on the
// actual app runtime. Extracting and checking the scheme directly with a
// plain regex is simpler, has no such gap, and needs no dependency.
// Requires the literal "://" after the scheme (not just "http:something")
// as an extra guard, and rejects anything whose scheme-like prefix isn't
// exactly http/https — including a bare "hostname:port" value, which
// would otherwise read its hostname as a fake "scheme" the same way the
// naive version of this check once did in the edit-mode normalizer.
export function getSafeWebsiteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

// Display-only relabeling — never touches the stored/opened URL. Strips a
// leading scheme and exactly one trailing slash, matching the spec's two
// explicit display rules and nothing more (no further casing/path
// rewriting).
export function formatWebsiteLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

export async function openWebsite(url: string) {
  const safeUrl = getSafeWebsiteUrl(url);
  if (!safeUrl) return;
  try {
    const canOpen = await Linking.canOpenURL(safeUrl);
    if (!canOpen) {
      Alert.alert('Unable to Open Link', "This link can't be opened right now.");
      return;
    }
    await Linking.openURL(safeUrl);
  } catch {
    Alert.alert('Unable to Open Link', 'Something went wrong opening this link.');
  }
}

// Fixed 'en-US' locale, not the device locale — matches this app's own
// existing convention (components/feed/post-card.tsx's formatAge already
// formats post dates via toLocaleDateString('en-US', ...) rather than the
// device locale), so profile dates and feed dates read consistently
// regardless of the device's own locale setting. Parses defensively:
// missing/empty/unparseable input returns null (never "Invalid Date").
function formatMemberSince(createdAt: string | null | undefined): string | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  const monthYear = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return `Member since ${monthYear}`;
}

export function ProfileV2Identity({
  displayName,
  username,
  showHeader = true,
  showActions = true,
  showDetails = true,
  tagline,
  bio,
  location,
  website,
  createdAt,
  mode,
  onEditPress,
  onFollowPress,
  onMessagePress,
  isFollowing,
  followLoading,
  messageLoading,
}: Props) {
  const safeWebsiteUrl = website ? getSafeWebsiteUrl(website) : null;
  const memberSince = formatMemberSince(createdAt);

  return (
    <View style={styles.wrap}>
      {showHeader && (
        <>
          {displayName ? (
            <Text style={styles.nameText} numberOfLines={1}>{displayName}</Text>
          ) : null}
          <Text style={styles.usernameText}>@{username}</Text>
        </>
      )}

      {showActions && (
        <View style={styles.actionRow}>
          {mode === 'owner' ? (
            <TouchableOpacity style={styles.editBtn} onPress={onEditPress} activeOpacity={0.85}>
              <Text style={styles.editBtnLabel}>Edit Profile</Text>
            </TouchableOpacity>
          ) : (
            <>
              <TouchableOpacity
                style={[styles.followBtn, isFollowing && styles.followBtnActive]}
                onPress={onFollowPress}
                disabled={followLoading}
                activeOpacity={0.85}>
                {followLoading ? (
                  <ActivityIndicator size="small" color={isFollowing ? PV2.textPrimary : '#fff'} />
                ) : (
                  <Text style={styles.followBtnLabel}>{isFollowing ? 'Following' : 'Follow'}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.messageBtn}
                onPress={onMessagePress}
                disabled={messageLoading}
                activeOpacity={0.85}>
                {messageLoading ? (
                  <ActivityIndicator size="small" color={PV2.textPrimary} />
                ) : (
                  <Text style={styles.messageBtnLabel}>Message</Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      {showDetails && (
        <>
      {tagline ? <Text style={styles.tagline}>{tagline}</Text> : null}
      {bio ? <Text style={styles.bio}>{bio}</Text> : null}
      {location ? <Text style={styles.location}>{location}</Text> : null}
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
          // Stored value isn't a safe http/https URL — shown as plain,
          // non-tappable text rather than either attempting unsafe
          // navigation or hiding a value the owner can see is saved.
          <Text style={styles.websiteInvalid}>{website}</Text>
        )
      ) : null}
      {memberSince ? <Text style={styles.memberSince}>{memberSince}</Text> : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    // Matches ProfileV2Preferences/ProfileV2Posts/the edit-mode
    // editSection's shared 16px inset (was 24 — the one section on this
    // screen with a different edge from everything else).
    paddingHorizontal: 16,
    marginTop: -2,
  },
  nameText: {
    color: PV2.textPrimary,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  usernameText: {
    color: PV2.textTertiary,
    fontSize: 13,
    marginTop: 2,
    marginBottom: 10,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 8,
    alignSelf: 'stretch',
    justifyContent: 'center',
  },
  editBtn: {
    flex: 1,
    maxWidth: 220,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editBtnLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  followBtn: {
    flex: 1,
    paddingVertical: 5,
    borderRadius: 20,
    backgroundColor: '#e8181a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  followBtnActive: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  followBtnLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  messageBtn: {
    flex: 1,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageBtnLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  // Distinct but restrained: a touch brighter/heavier than bio (which is
  // intentionally very dim), still no new color — PV2.textSecondary,
  // never PV2.accent, so it doesn't compete with the follow/edit buttons.
  tagline: {
    color: PV2.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 12,
  },
  bio: {
    // Was a hardcoded near-duplicate of PV2.textTertiary
    // (rgba(255,255,255,0.35) vs the token's 0.36) — same token, no
    // visual change, one fewer one-off color value in this file.
    color: PV2.textTertiary,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 12,
  },
  // Secondary, quieter than tagline/bio — plain text, no icon (no
  // matching icon exists yet in components/ui/icon-symbol.tsx's mapping).
  location: {
    color: PV2.textTertiary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
    paddingHorizontal: 12,
  },
  website: {
    color: PV2.link,
    fontSize: 12,
    marginTop: 4,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  // Same position/size as the tappable website style, but never PV2.link
  // (which reads as "interactive" in this design system) — a stored value
  // that failed validation must not look tappable.
  websiteInvalid: {
    color: PV2.textTertiary,
    fontSize: 12,
    marginTop: 4,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  // Same quiet metadata treatment as location — no icon, no new color,
  // never visually competes with tagline/bio above it.
  memberSince: {
    color: PV2.textTertiary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
    paddingHorizontal: 12,
  },
});
