import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { loadReportQueue } from '@/lib/admin-reports';
import {
  activeFilterCount,
  AGE_LABEL,
  DEFAULT_FILTERS,
  emptyText,
  failureMessage,
  isResolvedView,
  listAfterLoad,
  losesAccess,
  REASON_LABEL,
  rowSummary,
  SORT_LABEL,
  sortsFor,
  TARGET_LABEL,
  URGENCY_LABEL,
  URGENCY_TONE,
  VIEW_LABEL,
  VIEWS,
  withView,
  type AgeFilter,
  type ApiFailure,
  type ListState,
  type QueueCounts,
  type QueueFilters,
  type QueueItem,
  type Tone,
} from '@/lib/admin-reports-view';

// Admin-only report queue (Phase 2B M5.1). useIsAdmin only decides what
// renders; every row comes from admin_report_queue, which re-checks the
// caller server-side. Rows carry metadata only — type, reason, times,
// status, claim — never report text, evidence or identities. Decisions are
// made on the report screen (app/admin/report/[id].tsx).

const TONE_COLOR: Record<Tone, string> = {
  critical: PV2.statusNegative, warning: '#FF9F0A', ok: PV2.statusPositive, neutral: PV2.link, off: PV2.textTertiary,
};
const TONE_BG: Record<Tone, string> = {
  critical: 'rgba(255,59,48,0.16)', warning: 'rgba(255,159,10,0.16)', ok: PV2.statusPositiveSoft, neutral: PV2.actionPrimarySoft,
  off: 'rgba(255,255,255,0.08)',
};
const COUNT_KEY: Partial<Record<QueueFilters['view'], keyof QueueCounts>> = { open: 'open', claimed: 'claimed', mine: 'mine', reopened: 'reopened' };

export default function ReportsScreen() {
  const router = useRouter();
  const isAdmin = useIsAdmin();
  useScrollResponsiveNavbar({ enabled: false });

  const [filters, setFilters] = useState<QueueFilters>(DEFAULT_FILTERS);
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [access, setAccess] = useState<ApiFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Each load is tagged, so a slow response for old filters never
  // overwrites the list for the current ones.
  const generation = useRef(0);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }, [router]);

  useEffect(() => {
    if (isAdmin === false) leave();
  }, [isAdmin, leave]);

  const load = useCallback(
    async (f: QueueFilters, mode: 'replace' | 'refresh' | 'more', cursor: unknown | null = null) => {
      const gen = mode === 'more' ? generation.current : ++generation.current;
      if (mode === 'replace') setList({ kind: 'loading' });
      const res = await loadReportQueue(f, mode === 'more' ? cursor : null);
      if (gen !== generation.current) return;
      setNow(Date.now());
      if (res.kind !== 'ok' && losesAccess(res)) {
        setAccess(res);
        return;
      }
      if (res.kind === 'ok' && res.data.counts) setCounts(res.data.counts);
      setList((prev) => listAfterLoad(prev, res, mode === 'more'));
    },
    [],
  );

  // Reload whenever the screen regains focus (e.g. back from a report whose
  // state changed) and whenever the filters change.
  useFocusEffect(
    useCallback(() => {
      if (isAdmin === true) load(filters, 'refresh');
    }, [isAdmin, filters, load]),
  );

  // The focus effect below loads the new filters.
  const applyFilters = useCallback((next: QueueFilters) => {
    setList({ kind: 'loading' });
    setFilters(next);
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(filters, 'refresh');
    setRefreshing(false);
  }, [filters, load]);

  const onMore = useCallback(async () => {
    if (list.kind !== 'ok' || !list.cursor || loadingMore) return;
    setLoadingMore(true);
    await load(filters, 'more', list.cursor);
    setLoadingMore(false);
  }, [list, loadingMore, load, filters]);

  if (access) {
    return (
      <>
        <Stack.Screen options={{ title: 'Reports', headerBackTitle: '' }} />
        <View style={styles.centered}>
          <Text style={styles.empty}>{failureMessage(access)}</Text>
          <TouchableOpacity style={styles.button} onPress={leave} accessibilityRole="button">
            <Text style={styles.buttonText}>Back</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  }
  if (isAdmin !== true) {
    return (
      <>
        <Stack.Screen options={{ title: '', headerBackTitle: '' }} />
        <View style={styles.centered}>{isAdmin !== false ? <ActivityIndicator color={PV2.textSecondary} /> : null}</View>
      </>
    );
  }

  const nFilters = activeFilterCount(filters);
  const header = (
    <View style={styles.header}>
      {counts ? (
        <Text style={styles.subtitle} accessibilityLabel={`${counts.urgent} urgent and ${counts.child_safety} child-safety reports pending`}>
          Pending: {counts.open + counts.claimed}
          {counts.urgent ? ` · ${counts.urgent} urgent` : ''}
          {counts.child_safety ? ` · ${counts.child_safety} child safety` : ''}
        </Text>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {VIEWS.map((v) => {
          const key = COUNT_KEY[v];
          const n = key && counts ? counts[key] : null;
          return (
            <Chip
              key={v}
              label={`${VIEW_LABEL[v]}${n !== null ? ` ${n}` : ''}`}
              active={filters.view === v}
              onPress={() => filters.view !== v && applyFilters(withView(filters, v))}
            />
          );
        })}
      </ScrollView>
      <View style={styles.filterBar}>
        <TouchableOpacity onPress={() => setShowFilters((s) => !s)} accessibilityRole="button" accessibilityState={{ expanded: showFilters }}>
          <Text style={styles.link}>
            {showFilters ? 'Hide filters' : 'Filters'}
            {nFilters ? ` (${nFilters})` : ''}
          </Text>
        </TouchableOpacity>
        {nFilters ? (
          <TouchableOpacity onPress={() => applyFilters({ ...DEFAULT_FILTERS, view: filters.view })} accessibilityRole="button">
            <Text style={styles.link}>Clear</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {showFilters ? (
        <View style={styles.filters}>
          <FilterRow
            label="Type"
            value={filters.targetType}
            options={Object.keys(TARGET_LABEL).map((k) => [k, TARGET_LABEL[k]])}
            onChange={(targetType) => applyFilters({ ...filters, targetType })}
          />
          <FilterRow
            label="Reason"
            value={filters.reason}
            options={Object.keys(REASON_LABEL).map((k) => [k, REASON_LABEL[k]])}
            onChange={(reason) => applyFilters({ ...filters, reason })}
          />
          <FilterRow
            label="Priority"
            value={filters.priority}
            options={[['urgent', 'Urgent'], ['normal', 'Normal']]}
            onChange={(priority) => applyFilters({ ...filters, priority: priority as QueueFilters['priority'] })}
          />
          <FilterRow
            label="Age"
            value={filters.age}
            options={(Object.keys(AGE_LABEL) as AgeFilter[]).map((k) => [k, AGE_LABEL[k]])}
            onChange={(a) => applyFilters({ ...filters, age: a as AgeFilter | null })}
          />
          <FilterRow
            label="Sort"
            value={filters.sort}
            anyLabel={isResolvedView(filters.view) ? 'Newest first' : 'Urgent first'}
            options={sortsFor(filters.view)
              .filter((s) => s !== (isResolvedView(filters.view) ? 'newest' : 'priority'))
              .map((s) => [s, SORT_LABEL[s]])}
            onChange={(s) => applyFilters({ ...filters, sort: s as QueueFilters['sort'] })}
          />
        </View>
      ) : null}
    </View>
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Reports',
          headerBackTitle: '',
          headerRight: () => (
            <TouchableOpacity onPress={onRefresh} disabled={refreshing} accessibilityRole="button" accessibilityLabel="Refresh reports">
              <Text style={[styles.headerAction, refreshing && styles.dim]}>Refresh</Text>
            </TouchableOpacity>
          ),
        }}
      />
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <FlatList
          data={list.kind === 'ok' ? list.items : []}
          keyExtractor={(i) => i.id}
          renderItem={({ item }) => <Row item={item} now={now} onPress={() => router.push(`/admin/report/${item.id}`)} />}
          ListHeaderComponent={header}
          ListEmptyComponent={
            list.kind === 'loading' ? (
              <ActivityIndicator style={styles.spinner} color={PV2.textSecondary} accessibilityLabel="Loading reports" />
            ) : list.kind === 'error' ? (
              <View style={styles.stateBox}>
                <Text style={styles.error}>Couldn’t load reports. {list.message}</Text>
                <TouchableOpacity style={styles.button} onPress={() => load(filters, 'replace')} accessibilityRole="button">
                  <Text style={styles.buttonText}>Try again</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <Text style={styles.empty}>{emptyText(filters)}</Text>
            )
          }
          ListFooterComponent={
            list.kind === 'ok' && list.items.length > 0 ? (
              loadingMore ? (
                <ActivityIndicator style={styles.spinner} color={PV2.textSecondary} />
              ) : list.moreError ? (
                <TouchableOpacity style={styles.more} onPress={onMore} accessibilityRole="button">
                  <Text style={styles.error}>Couldn’t load more. Tap to retry.</Text>
                </TouchableOpacity>
              ) : list.cursor ? (
                <TouchableOpacity style={styles.more} onPress={onMore} accessibilityRole="button">
                  <Text style={styles.link}>Load more</Text>
                </TouchableOpacity>
              ) : (
                <Text style={styles.end}>End of list</Text>
              )
            ) : null
          }
          onEndReached={() => list.kind === 'ok' && !list.moreError && onMore()}
          onEndReachedThreshold={0.3}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PV2.link} />}
        />
      </SafeAreaView>
    </>
  );
}

function Row({ item, now, onPress }: { item: QueueItem; now: number; onPress: () => void }) {
  const s = rowSummary(item, now);
  const edge = s.urgency ? TONE_COLOR[URGENCY_TONE[s.urgency]] : PV2.panelBorder;
  return (
    <TouchableOpacity
      style={[styles.row, { borderLeftColor: edge }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${s.urgency ? `${URGENCY_LABEL[s.urgency]}. ` : ''}${s.title}. ${s.status}. ${s.detail}`}>
      <View style={styles.rowTop}>
        {s.urgency ? <Pill label={URGENCY_LABEL[s.urgency]} tone={URGENCY_TONE[s.urgency]} /> : null}
        <Text style={styles.rowTitle} numberOfLines={1}>
          {s.title}
        </Text>
        <Pill label={s.status} tone={s.statusTone} />
      </View>
      <Text style={styles.rowDetail}>
        {s.detail}
        {s.resolution ? ` · ${s.resolution}` : ''}
      </Text>
    </TouchableOpacity>
  );
}

function FilterRow({ label, value, options, onChange, anyLabel = 'Any' }: {
  label: string; value: string | null; options: [string, string][]; onChange: (v: string | null) => void; anyLabel?: string;
}) {
  return (
    <View style={styles.filterRow}>
      <Text style={styles.filterLabel}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        <Chip label={anyLabel} active={value === null} onPress={() => value !== null && onChange(null)} small />
        {options.map(([k, l]) => (
          <Chip key={k} label={l} active={value === k} onPress={() => value !== k && onChange(k)} small />
        ))}
      </ScrollView>
    </View>
  );
}
function Chip({ label, active, onPress, small }: { label: string; active: boolean; onPress: () => void; small?: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.chip, small && styles.chipSmall, active && styles.chipActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}
function Pill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <View style={[styles.pill, { backgroundColor: TONE_BG[tone] }]}>
      <Text style={[styles.pillText, { color: TONE_COLOR[tone] }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PV2.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, backgroundColor: PV2.bg },
  content: { padding: 16, paddingBottom: 40, gap: 8 },
  header: { gap: 8, marginBottom: 4 },
  headerAction: { color: PV2.link, fontSize: 15, fontWeight: '600' },
  dim: { opacity: 0.5 },
  subtitle: { fontSize: 12, color: PV2.textTertiary },
  tabs: { flexDirection: 'row', gap: 8, paddingVertical: 2 },
  filterBar: { flexDirection: 'row', justifyContent: 'space-between' },
  filters: { gap: 8, backgroundColor: PV2.panel, borderRadius: 12, padding: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.panelBorder },
  filterRow: { gap: 4 },
  filterLabel: { fontSize: 11, fontWeight: '700', color: PV2.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6 },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.border },
  chipSmall: { paddingVertical: 4, paddingHorizontal: 10 },
  chipActive: { backgroundColor: PV2.textPrimary, borderColor: PV2.textPrimary },
  chipText: { fontSize: 13, color: PV2.textSecondary, fontWeight: '500' },
  chipTextActive: { color: PV2.bg },
  row: {
    backgroundColor: PV2.panel, borderRadius: 10, padding: 12, gap: 4, borderLeftWidth: 4,
    borderWidth: StyleSheet.hairlineWidth, borderColor: PV2.panelBorder,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: PV2.textPrimary },
  rowDetail: { fontSize: 12, color: PV2.textTertiary },
  pill: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999 },
  pillText: { fontSize: 11, fontWeight: '700' },
  link: { color: PV2.link, fontSize: 13, fontWeight: '600' },
  button: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 18, borderRadius: 8, backgroundColor: PV2.actionPrimaryFill },
  buttonText: { color: PV2.textPrimary, fontSize: 14, fontWeight: '600' },
  stateBox: { gap: 12, paddingVertical: 16, alignItems: 'center' },
  more: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 16 },
  end: { alignSelf: 'center', fontSize: 12, color: PV2.textTertiary, paddingVertical: 10 },
  empty: { fontSize: 13, color: PV2.textSecondary, paddingVertical: 16, textAlign: 'center' },
  error: { fontSize: 13, color: PV2.statusNegative, textAlign: 'center' },
  spinner: { paddingVertical: 16 },
});
