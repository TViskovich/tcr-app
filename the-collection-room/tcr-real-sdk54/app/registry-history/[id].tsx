import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { HeaderBackButton } from '@react-navigation/elements';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useRegistryEvents } from '@/hooks/use-registry-events';
import { formatCustodyStatus } from '@/lib/registry-custody-status';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import type { CollectionItem, RegisteredCard, RegistryEvent, RegistryEventType } from '@/types';

type RegisteredCardWithItem = RegisteredCard & {
  collection_item: CollectionItem | null;
};

const EVENT_LABEL: Record<RegistryEventType, string> = {
  registered: 'Registry ID created',
  item_linked: 'Card linked to collection item',
  item_unlinked: 'Card unlinked from collection item',
  status_changed: 'Registry status updated',
  grading_updated: 'Grading information updated',
  ownership_transferred: 'Ownership transferred',
};

// event_type is a plain text column, not a TS-enforced union, at the
// database layer — a value outside RegistryEventType is not currently
// possible given the live CHECK constraint, but this stays defensive
// rather than assuming the constraint can never change without this
// screen also being updated.
function getEventLabel(eventType: string): string {
  return EVENT_LABEL[eventType as RegistryEventType] ?? 'Registry record updated';
}

// Renders a resolved collector name as tappable inline text that opens
// their public profile. Implemented as a nested <Text onPress> rather than
// a Pressable/View — a View-based component does not reliably flow inline
// inside a surrounding <Text> the way nested Text does, and sentences like
// "From X → Y" need to stay visually continuous rather than breaking onto
// their own line. Relies on the platform's native inline-text press
// highlight for feedback rather than tracked pressed state (no
// useState/onPressIn/onPressOut here). Only ever rendered by renderName
// below when a real username has resolved — never for a bare display name
// with no route-safe username, and never for a raw id.
function ProfileNameLink({
  name,
  username,
  onPress,
  style,
}: {
  name: string;
  username: string;
  onPress: (username: string) => void;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text style={[style, styles.profileNameLink]} onPress={() => onPress(username)}>
      {name}
    </Text>
  );
}

// Shared by every getEventDetail branch below — a resolved name becomes
// tappable only when its username also resolved; otherwise it renders as
// plain, non-interactive text (same visible string either way, since the
// displayed name always comes from resolveName, never from username).
function renderName(name: string, username: string | null, onPress: (username: string) => void): ReactNode {
  if (!username) return name;
  return <ProfileNameLink name={name} username={username} onPress={onPress} />;
}

// Only ever built from actor_id/from_owner_id/to_owner_id (or, for
// status_changed, old_custody_status/new_custody_status) — never from
// metadata (which, for item_linked/item_unlinked, contains only an
// internal collection_item_id and must never be surfaced here) and never
// a raw UUID (resolveName returns null rather than the id itself, so a
// failed lookup silently omits the detail line instead of leaking a raw
// UUID). registered, ownership_transferred, item_linked, item_unlinked,
// and status_changed each get their own phrasing; everything else falls
// back to a plain "By <name>" when the actor resolves. Returns a ReactNode
// (not a plain string) so the name portion can be an inline tappable link
// — the wrapping <Text style={styles.timelineDetail}> at the call site is
// unchanged, only what's inside it changes.
function getEventDetail(
  event: RegistryEvent,
  resolveName: (id: string | null) => string | null,
  resolveUsername: (id: string | null) => string | null,
  onProfilePress: (username: string) => void,
): ReactNode {
  if (event.event_type === 'registered') {
    const actorName = resolveName(event.actor_id);
    const name = actorName ?? resolveName(event.to_owner_id);
    if (!name) return null;
    const resolvedId = actorName ? event.actor_id : event.to_owner_id;
    return <>Registered by {renderName(name, resolveUsername(resolvedId), onProfilePress)}</>;
  }

  if (event.event_type === 'ownership_transferred') {
    const fromName = resolveName(event.from_owner_id);
    const toName = resolveName(event.to_owner_id);
    if (fromName && toName) {
      return (
        <>
          From {renderName(fromName, resolveUsername(event.from_owner_id), onProfilePress)} →{' '}
          {renderName(toName, resolveUsername(event.to_owner_id), onProfilePress)}
        </>
      );
    }
    if (toName) return <>To {renderName(toName, resolveUsername(event.to_owner_id), onProfilePress)}</>;
    if (fromName) return <>From {renderName(fromName, resolveUsername(event.from_owner_id), onProfilePress)}</>;
    return null;
  }

  if (event.event_type === 'item_linked') {
    const actorName = resolveName(event.actor_id);
    if (!actorName) return null;
    return <>Linked by {renderName(actorName, resolveUsername(event.actor_id), onProfilePress)}</>;
  }

  if (event.event_type === 'item_unlinked') {
    const actorName = resolveName(event.actor_id);
    if (!actorName) return null;
    return <>Unlinked by {renderName(actorName, resolveUsername(event.actor_id), onProfilePress)}</>;
  }

  // Registry Status v1 — old_custody_status/new_custody_status only, never
  // the existing registration-lifecycle `status` field. Populated only on
  // status_changed rows (see hooks/use-registry-events.ts); both null for
  // every other event type, which the earlier branches above already
  // handle before reaching here.
  if (event.event_type === 'status_changed') {
    const oldLabel = event.old_custody_status ? formatCustodyStatus(event.old_custody_status) : null;
    const newLabel = event.new_custody_status ? formatCustodyStatus(event.new_custody_status) : null;
    if (oldLabel && newLabel) {
      return (
        <>
          {oldLabel} → {newLabel}
        </>
      );
    }
    if (newLabel) return <>To {newLabel}</>;
    if (oldLabel) return <>From {oldLabel}</>;
    return null;
  }

  const actorName = resolveName(event.actor_id);
  if (!actorName) return null;
  return <>By {renderName(actorName, resolveUsername(event.actor_id), onProfilePress)}</>;
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Same identity logic as app/registry/[id].tsx and app/item/[id].tsx's
// buildIdentity — kept in sync deliberately rather than imported, matching
// this app's established per-screen-identity-helper convention.
function buildTitle(item: CollectionItem): string {
  return item.player?.trim() || item.title?.trim() || 'Untitled Item';
}

function buildSubtitle(item: CollectionItem): string | null {
  const mainTitle = buildTitle(item);
  const brand = item.brand?.trim() || null;
  const itemTitle = item.title?.trim() || null;

  const parts: (string | null)[] = [item.year != null ? String(item.year) : null, brand];
  if (itemTitle && itemTitle !== mainTitle) {
    parts.push(itemTitle);
  }

  return parts.filter(Boolean).join(' ') || null;
}

// Canonical certificate identity (registered_cards.snapshot_* — set once by
// register_card at registration, never touched by later collection_item
// edits or by ownership-transfer's collection_item_id clearing). A linked
// collection_item is an owner-specific organizational connection, not the
// source of truth — buildTitle/buildSubtitle above remain purely as the
// legacy fallback for records with no snapshot data. Kept in sync with the
// identical helpers in app/registry/[id].tsx rather than shared, matching
// this app's established per-screen-identity-helper convention.
function buildSnapshotTitle(record: RegisteredCard): string | null {
  return record.snapshot_player?.trim() || record.snapshot_title?.trim() || null;
}

function buildSnapshotSubtitle(record: RegisteredCard): string | null {
  const mainTitle = buildSnapshotTitle(record);
  const brand = record.snapshot_brand?.trim() || null;
  const snapshotTitle = record.snapshot_title?.trim() || null;

  if (record.snapshot_year == null && !brand && !snapshotTitle) {
    return null;
  }

  const parts: (string | null)[] = [record.snapshot_year != null ? String(record.snapshot_year) : null, brand];
  if (snapshotTitle && snapshotTitle !== mainTitle) {
    parts.push(snapshotTitle);
  }

  return parts.filter(Boolean).join(' ') || null;
}

// Full-page provenance timeline for one registered card — Phase: registry
// history foundation. Reached from app/registry/[id].tsx's "View Registry
// History" action. Renders only real registry_events rows in ascending
// (oldest-first) order; never fabricates or synthesizes an entry. Read-only
// — no transfer controls live on this screen (initiating/accepting a
// transfer happens elsewhere); it only displays the resulting
// ownership_transferred events once they exist.
export default function RegistryHistoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [record, setRecord] = useState<RegisteredCardWithItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Re-fetches independently rather than trusting only navigation params —
  // same convention as every other detail route in this app.
  useEffect(() => {
    if (!id) {
      setLoading(false);
      setNotFound(true);
      return;
    }

    async function load() {
      setLoading(true);
      setNotFound(false);
      setFetchError(null);
      setRecord(null);

      const { data, error } = await supabase
        .from('registered_cards')
        .select('*, collection_item:collection_items(*)')
        .eq('id', id)
        .maybeSingle();

      if (error) {
        console.error('[RegistryHistory] load failed:', error.message, error);
        setFetchError(error.message);
        setLoading(false);
        return;
      }

      if (!data) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      setRecord(data as unknown as RegisteredCardWithItem);
      setLoading(false);
    }

    load();
  }, [id]);

  const {
    events,
    loading: eventsLoading,
    error: eventsError,
    resolveName,
    resolveUsername,
  } = useRegistryEvents(record?.id);

  function handleBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)');
  }

  // Same route/pattern already used throughout the app (app/item/[id].tsx,
  // app/collection/[folderId].tsx, app/(tabs)/index.tsx,
  // app/(tabs)/search.tsx, app/(tabs)/notifications.tsx) — no new route.
  function handleProfilePress(username: string) {
    router.push({ pathname: '/user/[username]', params: { username } });
  }

  const headerBackLeft = () => <HeaderBackButton onPress={handleBack} displayMode="minimal" />;

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Registry History', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.link} />
        </View>
      </>
    );
  }

  if (fetchError) {
    return (
      <>
        <Stack.Screen options={{ title: 'Registry History', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>Could not load this registry record.</Text>
        </View>
      </>
    );
  }

  if (notFound || !record) {
    return (
      <>
        <Stack.Screen options={{ title: 'Registry History', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>Registry record not found.</Text>
        </View>
      </>
    );
  }

  const item = record.collection_item;
  // Snapshot-first: only falls back to the linked collection_item when no
  // snapshot identity field exists at all (legacy records registered
  // before Phase S2, or a card with no linked item) — never the reverse.
  // hasSnapshotIdentity gates the subtitle fallback specifically, since
  // buildSnapshotSubtitle() can legitimately return null (e.g. only
  // snapshot_player is set) even though canonical snapshot identity does
  // exist — that case must still not fall through to the owner-specific
  // linked item's subtitle. Kept in sync with app/registry/[id].tsx's
  // identical logic.
  const hasSnapshotIdentity =
    !!record.snapshot_player?.trim() ||
    !!record.snapshot_title?.trim() ||
    record.snapshot_year != null ||
    !!record.snapshot_brand?.trim() ||
    !!record.snapshot_team?.trim() ||
    !!record.snapshot_image_url;
  const snapshotTitle = buildSnapshotTitle(record);
  const snapshotSubtitle = buildSnapshotSubtitle(record);
  const image = record.snapshot_image_url ?? item?.image_url ?? null;
  const title = snapshotTitle || (item ? buildTitle(item) : null);
  const subtitle = hasSnapshotIdentity ? snapshotSubtitle : item ? buildSubtitle(item) : null;
  const ownerName = resolveName(record.current_owner_id);
  const ownerUsername = resolveUsername(record.current_owner_id);

  return (
    <>
      <Stack.Screen options={{ title: 'Registry History', headerLeft: headerBackLeft }} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }]}>
        <View style={styles.identityRow}>
          {image && <Image source={{ uri: image }} style={styles.identityImage} contentFit="cover" />}
          <View style={styles.identityText}>
            <Text style={styles.identityCcId}>{record.cc_id}</Text>
            {title && (
              <Text style={styles.identityTitle} numberOfLines={1}>
                {title}
              </Text>
            )}
            {subtitle && (
              <Text style={styles.identitySubtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            )}
            {ownerName && (
              <Text style={styles.identityOwnerLine} numberOfLines={1}>
                <Text style={styles.identityOwnerLabel}>Current owner: </Text>
                {ownerUsername ? (
                  <ProfileNameLink
                    name={ownerName}
                    username={ownerUsername}
                    onPress={handleProfilePress}
                    style={styles.identityOwnerValue}
                  />
                ) : (
                  <Text style={styles.identityOwnerValue}>{ownerName}</Text>
                )}
              </Text>
            )}
          </View>
        </View>

        <Text style={styles.sectionHeader}>Timeline</Text>

        {eventsLoading ? (
          <View style={styles.timelineLoadingWrap}>
            <ActivityIndicator size="small" color={PV2.textTertiary} />
          </View>
        ) : eventsError ? (
          <View style={styles.timelineMessageWrap}>
            <Text style={styles.timelineMessageText}>Could not load registry history.</Text>
          </View>
        ) : events.length === 0 ? (
          <View style={styles.timelineMessageWrap}>
            <Text style={styles.timelineMessageText}>No history events recorded yet.</Text>
          </View>
        ) : (
          <View style={styles.timeline}>
            {events.map((event, index) => {
              const isLast = index === events.length - 1;
              const detail = getEventDetail(event, resolveName, resolveUsername, handleProfilePress);
              return (
                <View key={event.id} style={styles.timelineRow}>
                  <View style={styles.timelineMarkerCol}>
                    <View style={styles.timelineDot} />
                    {!isLast && <View style={styles.timelineLine} />}
                  </View>
                  <View style={[styles.timelineContent, !isLast && styles.timelineContentSpacing]}>
                    <Text style={styles.timelineLabel}>{getEventLabel(event.event_type)}</Text>
                    <Text style={styles.timelineDate}>{formatDateTime(event.created_at)}</Text>
                    {detail && <Text style={styles.timelineDetail}>{detail}</Text>}
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.bg,
  },
  errorText: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  scroll: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 24,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  identityImage: {
    width: 52,
    height: 52,
    borderRadius: 10,
    backgroundColor: PV2.panel,
  },
  identityText: {
    flex: 1,
  },
  identityCcId: {
    fontSize: 15,
    fontWeight: '800',
    color: PV2.textPrimary,
    letterSpacing: 0.8,
  },
  identityTitle: {
    marginTop: 2,
    fontSize: 14,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  identitySubtitle: {
    marginTop: 1,
    fontSize: 12,
    color: PV2.textTertiary,
  },
  identityOwnerLine: {
    marginTop: 1,
  },
  identityOwnerLabel: {
    fontSize: 12,
    color: PV2.textTertiary,
  },
  identityOwnerValue: {
    fontSize: 12,
    color: PV2.textSecondary,
    fontWeight: '600',
  },
  // Matches the app's existing inline-link text treatment exactly — see
  // components/profile-v2/profile-v2-identity.tsx's `website` style, the
  // only other place PV2.link is used as plain text color rather than an
  // icon/indicator tint. Deliberately just a color change (no underline,
  // no weight override) so it composes correctly with whichever
  // surrounding text style (identityOwnerValue, timelineDetail) it's
  // layered on top of.
  profileNameLink: {
    color: PV2.link,
  },
  sectionHeader: {
    marginTop: 28,
    marginBottom: 14,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
  },
  timelineLoadingWrap: {
    paddingVertical: 24,
    alignItems: 'center',
  },
  timelineMessageWrap: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingVertical: 20,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  timelineMessageText: {
    fontSize: 13,
    color: PV2.textTertiary,
    textAlign: 'center',
  },
  timeline: {
    paddingBottom: 8,
  },
  timelineRow: {
    flexDirection: 'row',
  },
  timelineMarkerCol: {
    width: 20,
    alignItems: 'center',
  },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#34C759',
    marginTop: 3,
  },
  timelineLine: {
    flex: 1,
    width: 2,
    minHeight: 24,
    backgroundColor: PV2.dividerColor,
    marginTop: 4,
  },
  timelineContent: {
    flex: 1,
    marginLeft: 12,
  },
  timelineContentSpacing: {
    paddingBottom: 20,
  },
  timelineLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  timelineDate: {
    marginTop: 2,
    fontSize: 12,
    color: PV2.textTertiary,
  },
  timelineDetail: {
    marginTop: 4,
    fontSize: 13,
    color: PV2.textSecondary,
  },
});
