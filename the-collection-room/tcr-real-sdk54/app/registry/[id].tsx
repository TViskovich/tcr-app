import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { HeaderBackButton } from '@react-navigation/elements';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { getRegistryPublicUrl } from '@/lib/registry-links';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import type { CollectionItem, RegisteredCard, RegisteredCardStatus } from '@/types';

type RegisteredCardWithItem = RegisteredCard & {
  collection_item: CollectionItem | null;
};

// registered_cards.current_owner_id has no FK relationship to
// public.profiles (it references auth.users(id) — see RegisteredCard's own
// comment in types/index.ts), so it can't be embedded in the query above.
// Fetched separately, same pattern as app/item/[id].tsx's ownerProfile.
type OwnerProfile = {
  username: string;
  display_name: string | null;
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

const STATUS_LABEL: Record<RegisteredCardStatus, string> = {
  owner_registered: 'Active',
  active: 'Active',
  inactive: 'Inactive',
  owner_account_deleted: 'Owner account deleted',
};

// Status-only — the owner/date facts already live in the info panel above,
// this describes the health of the registry ID itself, not who owns it or
// when it was registered.
function buildStatusSentence(status: RegisteredCardStatus): string {
  if (status === 'owner_registered' || status === 'active') {
    return 'This Registry ID is active and in good standing.';
  }
  if (status === 'inactive') {
    return 'This Registry ID is currently inactive.';
  }
  if (status === 'owner_account_deleted') {
    return 'This Registry ID remains valid, but the owning account has been deleted.';
  }
  return `This Registry ID's status is ${STATUS_LABEL[status]}.`;
}

// Same identity logic as app/item/[id].tsx's buildIdentity — player is the
// primary title, falling back to the item's own title. Kept in sync
// deliberately rather than imported.
function buildTitle(item: CollectionItem): string {
  return item.player?.trim() || item.title?.trim() || 'Untitled Item';
}

// year + brand + item title, e.g. "2018 Donruss Rated Rookie" — each part
// included only when present/non-empty. item.title is appended last, and
// only when it differs from the main title buildTitle() already displays
// (e.g. when player is set, item.title is often a distinct card
// designation like "Rated Rookie" rather than a duplicate of the player
// name) — this is what surfaces the card's own title without ever
// duplicating what's already shown above it.
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

// Minimal registry detail screen — Phase 2B1 scope. Reached from the item-
// detail "View Registry" action once a card is registered. Deliberately
// bare: no QR, no ownership/provenance history, no verification scoring,
// no transfer controls, no edit — those are later CacheCase Registry
// sub-phases. Fetches fresh by id (same convention as every other detail
// route in this app — item/[id].tsx, collection/[folderId].tsx,
// post/[id].tsx, conversation/[id].tsx all re-fetch by id rather than
// trusting only passed params) so it also works if reached via a future
// direct link, not just via in-app navigation.
export default function RegistryDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [record, setRecord] = useState<RegisteredCardWithItem | null>(null);
  const [ownerProfile, setOwnerProfile] = useState<OwnerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // Distinct from notFound: a genuine query failure (network/RLS/etc.)
  // must never be presented as "this record doesn't exist," which would
  // hide the actual cause.
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      // No route parameter at all — nothing to query. Without this,
      // loading (which starts true) would never resolve.
      setLoading(false);
      setNotFound(true);
      return;
    }

    async function load() {
      setLoading(true);
      setNotFound(false);
      setFetchError(null);
      // Clears any previously loaded record so stale registry data can't
      // remain visible while navigating from one registry page to another.
      setRecord(null);
      setOwnerProfile(null);

      const { data, error } = await supabase
        .from('registered_cards')
        .select('*, collection_item:collection_items(*)')
        .eq('id', id)
        .maybeSingle();

      if (error) {
        console.error('[RegistryDetail] load failed:', error.message, error);
        setFetchError(error.message);
        setLoading(false);
        return;
      }

      if (!data) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      const row = data as unknown as RegisteredCardWithItem;
      setRecord(row);

      // Best-effort — a missing/failed owner lookup shouldn't block showing
      // the registry record itself (e.g. current_owner_id is null when the
      // owning account was deleted, per registered_cards' own SET NULL
      // design).
      if (row.current_owner_id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('username, display_name')
          .eq('id', row.current_owner_id)
          .maybeSingle();
        if (profile) setOwnerProfile(profile as OwnerProfile);
      }

      setLoading(false);
    }

    load();
  }, [id]);

  function handleBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)');
  }

  const headerBackLeft = () => <HeaderBackButton onPress={handleBack} displayMode="minimal" />;

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Registry', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.link} />
        </View>
      </>
    );
  }

  if (fetchError) {
    return (
      <>
        <Stack.Screen options={{ title: 'Registry', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>Could not load this registry record.</Text>
        </View>
      </>
    );
  }

  if (notFound || !record) {
    return (
      <>
        <Stack.Screen options={{ title: 'Registry', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>Registry record not found.</Text>
        </View>
      </>
    );
  }

  const item = record.collection_item;
  const title = item ? buildTitle(item) : null;
  const subtitle = item ? buildSubtitle(item) : null;
  const ownerName = ownerProfile?.display_name || ownerProfile?.username || 'Unavailable';
  const yearValue = item?.year ?? null;
  const teamValue = item?.team?.trim() || null;
  const hasYear = yearValue != null;
  const hasTeam = !!teamValue;
  const statusLabel = STATUS_LABEL[record.status];
  const statusSentence = buildStatusSentence(record.status);
  // Public QR payload — built only from the public cc_id, never
  // record.id/collection_item_id/current_owner_id. null whenever no real
  // base URL is configured or cc_id is somehow blank; see
  // lib/registry-links.ts for why no fallback domain is used.
  const registryPublicUrl = getRegistryPublicUrl(record.cc_id);

  return (
    <>
      <Stack.Screen options={{ title: record.cc_id, headerLeft: headerBackLeft }} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }]}>
        {item?.image_url && (
          <View style={styles.imageWrap}>
            <Image source={{ uri: item.image_url }} style={styles.image} contentFit="cover" />
          </View>
        )}

        <View style={styles.certificateHeader}>
          <Text style={styles.registryLabel}>CacheCase Registry</Text>
          <Text style={styles.certificateLabel}>Certificate ID</Text>
          <Text style={styles.ccId}>{record.cc_id}</Text>
        </View>
        <View style={styles.statusRow}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>Registered</Text>
        </View>

        {title && (
          <Text style={styles.itemTitle} numberOfLines={2}>
            {title}
          </Text>
        )}
        {subtitle && (
          <Text style={styles.itemSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        )}

        <View style={styles.infoPanel}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Registered</Text>
            <Text style={styles.infoValue}>{formatDate(record.created_at)}</Text>
          </View>
          <View style={[styles.infoRow, !hasYear && !hasTeam && styles.infoRowLast]}>
            <Text style={styles.infoLabel}>Current owner</Text>
            <Text style={styles.infoValue} numberOfLines={1}>
              {ownerName}
            </Text>
          </View>
          {hasYear && (
            <View style={[styles.infoRow, !hasTeam && styles.infoRowLast]}>
              <Text style={styles.infoLabel}>Year</Text>
              <Text style={styles.infoValue}>{yearValue}</Text>
            </View>
          )}
          {hasTeam && (
            <View style={[styles.infoRow, styles.infoRowLast]}>
              <Text style={styles.infoLabel}>Team</Text>
              <Text style={styles.infoValue}>{teamValue}</Text>
            </View>
          )}
        </View>

        <View style={styles.statusPanel}>
          <Text style={styles.statusPanelHeader}>Registry Status</Text>
          <View style={styles.statusPanelRow}>
            <View style={styles.statusPanelDot} />
            <Text style={styles.statusPanelLabel}>{statusLabel}</Text>
          </View>
          <Text style={styles.statusPanelSentence}>{statusSentence}</Text>
        </View>

        <View style={styles.qrPanel}>
          <Text style={styles.qrPanelHeader}>Public Registry Link</Text>
          {registryPublicUrl ? (
            <>
              <View style={styles.qrCard}>
                <QRCode value={registryPublicUrl} size={160} color="#000000" backgroundColor="#FFFFFF" />
              </View>
              <Text style={styles.qrCcIdLabel}>{record.cc_id}</Text>
            </>
          ) : (
            <View style={styles.qrUnavailable}>
              <Text style={styles.qrUnavailableText}>Public registry link unavailable</Text>
            </View>
          )}
        </View>
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
    alignItems: 'center',
  },
  imageWrap: {
    width: 200,
    aspectRatio: 5 / 7,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: PV2.panel,
    marginBottom: 20,
  },
  image: {
    flex: 1,
  },
  certificateHeader: {
    width: '100%',
    marginTop: 16,
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(160,140,220,0.38)',
    backgroundColor: 'rgba(160,140,220,0.10)',
    alignItems: 'center',
  },
  registryLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
  },
  certificateLabel: {
    marginTop: 10,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
  },
  ccId: {
    marginTop: 4,
    fontSize: 20,
    fontWeight: '700',
    color: PV2.textPrimary,
    letterSpacing: 1.2,
    fontVariant: ['tabular-nums'],
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(52,199,89,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(52,199,89,0.35)',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#34C759',
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  itemTitle: {
    marginTop: 16,
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
    textAlign: 'center',
  },
  itemSubtitle: {
    marginTop: 4,
    fontSize: 13,
    color: PV2.textTertiary,
    textAlign: 'center',
  },
  infoPanel: {
    width: '100%',
    marginTop: 24,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 16,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  infoRowLast: {
    borderBottomWidth: 0,
  },
  infoLabel: {
    fontSize: 13,
    color: PV2.textTertiary,
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  statusPanel: {
    width: '100%',
    marginTop: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  statusPanelHeader: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
  },
  statusPanelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  statusPanelDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#34C759',
  },
  statusPanelLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  statusPanelSentence: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 18,
    color: PV2.textSecondary,
  },
  qrPanel: {
    width: '100%',
    marginTop: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  qrPanelHeader: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: PV2.textTertiary,
  },
  // White card so the QR keeps full black-on-white contrast regardless of
  // the surrounding dark theme — required for the code to stay reliably
  // scannable.
  qrCard: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },
  qrCcIdLabel: {
    marginTop: 10,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.5,
    color: PV2.textSecondary,
  },
  qrUnavailable: {
    marginTop: 12,
    paddingVertical: 24,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  qrUnavailableText: {
    fontSize: 13,
    color: PV2.textTertiary,
    textAlign: 'center',
  },
});
