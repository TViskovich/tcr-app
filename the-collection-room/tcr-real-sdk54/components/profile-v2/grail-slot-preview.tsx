import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';

import { IconSymbol } from '@/components/ui/icon-symbol';
import type { CollectionItem, Folder, GrailSlot } from '@/types';

import { PV2 } from './profile-v2-theme';

const AnimatedExpoImage = Animated.createAnimatedComponent(Image);

// ~5s hold, ~850ms crossfade — modeled on app/collection/[folderId].tsx's
// own hero-carousel crossfade (prefetch-then-fade, cancelable), but
// self-rescheduling instead of swipe-driven.
const HOLD_DURATION_MS = 5000;
const FADE_DURATION_MS = 850;
// Deterministic initial-only stagger so adjacent collection slots don't
// all crossfade in lockstep — applied once, on this component instance's
// very first activation, never re-applied on a later focus/foreground
// resume (a paused-then-resumed slideshow restarts from a fresh hold, but
// not a re-staggered one).
const STAGGER_STEP_MS = 550;
// Long-press opens the Replace/Remove menu; this window suppresses the
// tap-driven navigation that would otherwise also fire. Time-based (not a
// boolean flag reset inside onPress) because onPress may simply never
// fire after onLongPress resolves — Pressable's normal behavior — which
// would leave a boolean flag stuck true and silently eat every future tap
// on this slot. This self-expires unconditionally after the window,
// regardless of which callbacks do or don't fire afterward.
const SUPPRESS_WINDOW_MS = 400;

type Props = {
  slot: GrailSlot | null;
  slotIndex: number;
  isOwnProfile: boolean;
  onPressEmpty: (slotIndex: number) => void;
  onPressItem: (item: CollectionItem) => void;
  onPressCollection: (collection: Folder) => void;
  onReplace: (slotIndex: number) => void;
  onRemove: (slotIndex: number) => void;
};

export function GrailSlotPreview({
  slot,
  slotIndex,
  isOwnProfile,
  onPressEmpty,
  onPressItem,
  onPressCollection,
  onReplace,
  onRemove,
}: Props) {
  const reducedMotion = useReducedMotion();

  // Route-focus tracking (expo-router's own useFocusEffect, matching this
  // codebase's existing convention elsewhere — e.g. app/collection/
  // [folderId].tsx's refetch-on-focus) — insufficient alone, since a
  // screen can stay "focused" in the navigator while the OS backgrounds
  // the whole app, so this is combined with AppState below.
  const [isRouteFocused, setIsRouteFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setIsRouteFocused(true);
      return () => setIsRouteFocused(false);
    }, []),
  );

  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setIsAppActive(state === 'active'));
    return () => sub.remove();
  }, []);

  // Broken-image detection — the practical interpretation of "filter
  // zero-byte images": a URL string alone can't cheaply reveal byte size
  // without a network request per image, but a failed decode (onError)
  // reliably marks a URL unusable, and rotation skips it going forward.
  const [brokenUrls, setBrokenUrls] = useState<Set<string>>(new Set());
  const markBroken = useCallback((url: string) => {
    setBrokenUrls((prev) => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  }, []);

  const usableImages = useMemo(
    () =>
      slot?.entry_type === 'collection'
        ? (slot.previewImages ?? []).filter((u) => !brokenUrls.has(u))
        : [],
    [slot, brokenUrls],
  );
  const usableImagesRef = useRef<string[]>(usableImages);
  useEffect(() => {
    usableImagesRef.current = usableImages;
  }, [usableImages]);

  // Tracked by URI, not array index — an index into a dynamically
  // filtered list (brokenUrls changes) can silently point at a different
  // image than the one it pointed at when it was captured. activeUri is
  // "what's currently shown on the bottom layer," incomingUri is "what's
  // currently fading in on the top layer, if anything."
  const [activeUri, setActiveUri] = useState<string | null>(null);
  const activeUriRef = useRef<string | null>(null);
  useEffect(() => {
    activeUriRef.current = activeUri;
  }, [activeUri]);

  const [incomingUri, setIncomingUri] = useState<string | null>(null);
  const topOpacity = useSharedValue(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasStartedRef = useRef(false);

  // React Strict Mode double-invokes effects (mount → cleanup → mount) in
  // dev — a ref that's only ever set false in a cleanup function starts
  // as `undefined`/falsy either way, so that alone can't distinguish
  // "never mounted yet" from "unmounted." Explicitly flips true on the
  // real mount and false on unmount, so an in-flight prefetch/timeout
  // callback that resolves between the first effect's cleanup and the
  // second's setup is correctly treated as still-mounted.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const commitSwap = useCallback(
    (landedUri: string) => {
      if (!mountedRef.current) return;
      setActiveUri(landedUri);
      setIncomingUri(null);
      cancelAnimation(topOpacity);
      topOpacity.value = 0;
    },
    [topOpacity],
  );

  const shouldAnimate = isRouteFocused && isAppActive && !reducedMotion && usableImages.length > 1;

  // Single effect drives both reconciliation and scheduling, re-running
  // whenever shouldAnimate flips OR usableImages changes identity (a
  // source went broken, the slot's previewImages refreshed, the slot
  // itself changed). Every run starts by tearing down any in-flight
  // transition unconditionally — a fade that started against the OLD
  // list must never be allowed to land (commit or even keep rendering)
  // against a list that's since changed underneath it — then reconciles
  // activeUri: kept as-is if still present in the new list, otherwise
  // falls back to the new list's first image (or null).
  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    cancelAnimation(topOpacity);
    topOpacity.value = 0;
    setIncomingUri(null);

    setActiveUri((prevActive) => {
      if (prevActive && usableImages.includes(prevActive)) return prevActive;
      return usableImages[0] ?? null;
    });

    if (!shouldAnimate) {
      return;
    }

    function scheduleTick(delay: number) {
      timeoutRef.current = setTimeout(tick, delay);
    }

    function tick() {
      const images = usableImagesRef.current;
      if (images.length < 2) return;
      const activeNow = activeUriRef.current;
      const activeIdx = activeNow ? images.indexOf(activeNow) : -1;
      const upcomingIdx = activeIdx === -1 ? 0 : (activeIdx + 1) % images.length;
      const upcomingUri = images[upcomingIdx];
      if (!upcomingUri) return;
      Image.prefetch(upcomingUri)
        .catch(() => {})
        .finally(() => {
          if (!mountedRef.current) return;
          // The list this tick was scheduled against may have already
          // been superseded by a newer effect run (which tears down and
          // reschedules independently) — re-check membership against the
          // latest list before committing to a fade, so a stale tick can
          // never display or commit an image the current list no longer
          // considers usable.
          if (!usableImagesRef.current.includes(upcomingUri)) return;
          setIncomingUri(upcomingUri);
          topOpacity.value = withTiming(1, { duration: FADE_DURATION_MS }, (finished) => {
            if (finished) {
              runOnJS(commitSwap)(upcomingUri);
              runOnJS(scheduleTick)(HOLD_DURATION_MS);
            }
          });
        });
    }

    // Stagger only ever applies once, on this instance's very first
    // activation — a later pause/resume (focus loss, backgrounding,
    // Reduce Motion toggle, a usableImages change) restarts from a fresh
    // hold but without re-staggering.
    const initialDelay = HOLD_DURATION_MS + (hasStartedRef.current ? 0 : slotIndex * STAGGER_STEP_MS);
    hasStartedRef.current = true;
    scheduleTick(initialDelay);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      cancelAnimation(topOpacity);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAnimate, usableImages]);

  const topAnimatedStyle = useAnimatedStyle(() => ({ opacity: topOpacity.value }));

  // Long-press-vs-tap suppression — see the SUPPRESS_WINDOW_MS comment above.
  const suppressPressUntilRef = useRef(0);

  // Even under ON DELETE CASCADE, a row could transiently carry an id
  // with no resolved joined object (RLS edge case, race, malformed data).
  const hasResolvedItem = slot?.entry_type === 'item' && !!slot.item;
  const hasResolvedCollection = slot?.entry_type === 'collection' && !!slot.collection;
  const missingSource = !!slot && !hasResolvedItem && !hasResolvedCollection;

  // Kept as separate, independently-gated flags rather than one combined
  // "tappable" boolean — navigation and owner management are different
  // privileges with different rules. In particular, an unavailable
  // (missing-source) slot must never navigate for anyone, but the owner
  // must still be able to long-press it to Replace or Remove the row —
  // collapsing these into one flag disabled the whole Pressable and made
  // an unavailable slot un-fixable without going through Supabase
  // directly.
  const canNavigate = hasResolvedItem || hasResolvedCollection;
  const canOpenOwnerMenu = isOwnProfile && !!slot;
  const canPressEmpty = isOwnProfile && !slot;
  const isInteractive = canNavigate || canOpenOwnerMenu || canPressEmpty;

  function handleLongPress() {
    if (!canOpenOwnerMenu) return;
    suppressPressUntilRef.current = Date.now() + SUPPRESS_WINDOW_MS;
    Alert.alert('Grail Slot', undefined, [
      { text: 'Replace', onPress: () => onReplace(slotIndex) },
      { text: 'Remove', style: 'destructive', onPress: () => onRemove(slotIndex) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function handlePress() {
    if (Date.now() < suppressPressUntilRef.current) return;
    if (!slot) {
      if (canPressEmpty) onPressEmpty(slotIndex);
      return;
    }
    if (!canNavigate) return; // unavailable slot — never navigates, even for the owner
    if (slot.entry_type === 'item' && slot.item) {
      onPressItem(slot.item);
    } else if (slot.entry_type === 'collection' && slot.collection) {
      onPressCollection(slot.collection);
    }
  }

  return (
    <Pressable
      style={styles.slot}
      onPress={isInteractive ? handlePress : undefined}
      onLongPress={canOpenOwnerMenu ? handleLongPress : undefined}
      disabled={!isInteractive}>
      {!slot ? (
        isOwnProfile ? (
          <View style={styles.slotEmptyOwner}>
            <IconSymbol name="plus" size={18} color="rgba(255,255,255,0.20)" />
          </View>
        ) : (
          <View style={styles.slotEmpty} />
        )
      ) : missingSource ? (
        <View style={styles.slotUnavailable}>
          <Text style={styles.unavailableText}>Unavailable</Text>
        </View>
      ) : slot.entry_type === 'item' ? (
        <View style={styles.itemWrap}>
          {slot.item!.image_url ? (
            <Image
              source={{ uri: slot.item!.image_url }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={150}
            />
          ) : (
            <View style={styles.slotEmptyFill} />
          )}
        </View>
      ) : (
        <View style={styles.collectionWrap}>
          {activeUri ? (
            <>
              <Image
                source={{ uri: activeUri }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                onError={() => markBroken(activeUri)}
              />
              {incomingUri && (
                <AnimatedExpoImage
                  source={{ uri: incomingUri }}
                  style={[StyleSheet.absoluteFill, topAnimatedStyle]}
                  contentFit="cover"
                  onError={() => markBroken(incomingUri)}
                />
              )}
            </>
          ) : (
            <View style={styles.slotEmptyFill} />
          )}
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.78)']} style={styles.collectionScrim}>
            <Text style={styles.collectionLabel} numberOfLines={1}>
              {slot.collection!.name}
            </Text>
            {typeof slot.collectionItemCount === 'number' && (
              <Text style={styles.collectionSubLabel} numberOfLines={1}>
                {slot.collectionItemCount} {slot.collectionItemCount === 1 ? 'item' : 'items'}
              </Text>
            )}
          </LinearGradient>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  slot: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: PV2.emptyCardBg,
  },
  slotEmptyOwner: {
    flex: 1,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotEmpty: {
    flex: 1,
  },
  slotEmptyFill: {
    flex: 1,
    backgroundColor: PV2.emptyCardBg,
  },
  slotUnavailable: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unavailableText: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.30)',
  },
  itemWrap: {
    flex: 1,
  },
  collectionWrap: {
    flex: 1,
  },
  collectionScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 5,
    paddingTop: 12,
    paddingBottom: 4,
  },
  collectionLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  collectionSubLabel: {
    fontSize: 8.5,
    color: 'rgba(255,255,255,0.72)',
    marginTop: 1,
  },
});
