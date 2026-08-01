import { ActivityIndicator, Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { PV2 } from './profile-v2-theme';

// Name/username now render as an overlay on the hero itself (see
// profile-v2-hero.tsx) rather than here, per the reference — this component
// owns the action row, tagline, bio, location, and website.
//
// mode is 'owner' for the signed-in user's own profile, 'public' when
// viewing someone else's (components/profile-v2/profile-v2-screen.tsx,
// shared by both app/(tabs)/profile.tsx and app/user/[username].tsx).
// Identity/preference data itself is identical for owner and visitor —
// only the action row (Edit vs. Follow/Message) differs by mode.
type Props = {
  tagline?: string | null;
  bio: string | null;
  location?: string | null;
  // website is normalized at save time (profile-v2-screen.tsx's
  // normalizeWebsiteInput), but re-validated here too before ever being
  // rendered as tappable — defense in depth against a value that reached
  // the database some other way.
  website?: string | null;
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
function getSafeWebsiteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

// Display-only relabeling — never touches the stored/opened URL. Strips a
// leading scheme and exactly one trailing slash, matching the spec's two
// explicit display rules and nothing more (no further casing/path
// rewriting).
function formatWebsiteLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

async function openWebsite(url: string) {
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

export function ProfileV2Identity({
  tagline,
  bio,
  location,
  website,
  mode,
  onEditPress,
  onFollowPress,
  onMessagePress,
  isFollowing,
  followLoading,
  messageLoading,
}: Props) {
  const safeWebsiteUrl = website ? getSafeWebsiteUrl(website) : null;

  return (
    <View style={styles.wrap}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingHorizontal: 24,
    marginTop: -2,
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
    color: 'rgba(255,255,255,0.35)',
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
});
