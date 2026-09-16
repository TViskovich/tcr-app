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

import { useAuth } from '@/lib/auth';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';
import type { CollectionItem, Folder, GrailSlot } from '@/types';

import { PV2 } from './profile-v2-theme';

const AnimatedExpoImage = Animated.createAnimatedComponent(Image);

// Standard trading-card proportion (2.5in x 3.5in), not a square — must
// match profile-v2-grid.tsx's own CARD_ASPECT_RATIO (loadingCell)
// exactly, so the loading placeholder and the real card never visibly
// change shape when data arrives.
const CARD_ASPECT_RATIO = 2.5 / 3.5;

// ~5s hold, ~850ms crossfade — modeled on app/collection/[folderId].tsx's
// own hero-carousel crossfade (prefetch-then-fade, cancelable), but
// self-rescheduling instead of swipe-driven.
const HOLD_DURATION_MS = 4200;
const FADE_DURATION_MS = 700;
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
  // Resolved once for the whole 3x3 grid by the parent (ProfileV2Grid) via
  // a single useSignedItemImages call — item-images beta privacy
  // hardening, Phase 3C. Keyed by collection_item_images.id: an item
  // slot's own primary_image_id, or (signed-delivery migration) one of a
  // collection slot's slot.previewImageIds — never a raw storage path.
  signedImageUrls: Map<string, string>;
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
  signedImageUrls,
  isOwnProfile,
  onPressEmpty,
  onPressItem,
  onPressCollection,
  onReplace,
  onRemove,
}: Props) {
  const reducedMotion = useReducedMotion();

  // Same identity useSignedItemImages itself keys its cache by (this
  // component doesn't call that hook directly — signedImageUrls is
  // resolved once for the whole grid by the parent, ProfileV2Grid — but
  // still needs its own useAuth() read here, cheap and backed by the same
  // single app-wide subscription, to build each image's stable expo-image
  // cacheKey; Phase 2 of the private-image caching upgrade — see
  // lib/private-image-cache-key.ts). Never a second identity concept.
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';

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

  // previewImageIds are collection_item_images.id values, resolved through
  // the same shared signedImageUrls map an item slot's primary_image_id
  // uses — never rendered as raw ids, and an id that hasn't resolved yet
  // (still loading, or the server said unavailable) is simply dropped
  // rather than falling back to any raw/public URL.
  const usableImages = useMemo(
    () =>
      slot?.entry_type === 'collection'
        ? (slot.previewImageIds ?? [])
            .map((id) => signedImageUrls.get(id))
            .filter((u): u is string => !!u && !brokenUrls.has(u))
        : [],
    [slot, signedImageUrls, brokenUrls],
  );
  const usableImagesRef = useRef<string[]>(usableImages);
  useEffect(() => {
    usableImagesRef.current = usableImages;
  }, [usableImages]);

  // Reverse (url -> collection_item_images.id) lookup, built alongside
  // usableImages from the exact same previewImageIds/signedImageUrls — NOT
  // a second source of truth. Exists purely so activeUri/incomingUri below
  // (tracked by URL, deliberately unchanged — see that state's own
  // comment) can still resolve each one's own correct, per-image stable
  // cacheKey at render time, without touching the carefully-sequenced
  // crossfade state machine that already works in terms of URLs. Safe as a
  // one-to-one map: every id's own signed URL is independently generated
  // (unique signature/query params) even when two ids happen to reference
  // the same underlying storage object, so distinct ids never collide on
  // the same URL string here.
  const idByUri = useMemo(() => {
    const map = new Map<string, string>();
    if (slot?.entry_type === 'collection') {
      for (const id of slot.previewImageIds ?? []) {
        const url = signedImageUrls.get(id);
        if (url) map.set(url, id);
      }
    }
    return map;
  }, [slot, signedImageUrls]);

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
  const incomingUriRef = useRef<string | null>(null);
  useEffect(() => {
    incomingUriRef.current = incomingUri;
  }, [incomingUri]);
  // Guards a single mounted incoming-image instance from triggering the
  // fade more than once — expo-image's onLoad can in principle fire again
  // for the same mounted element, and without this a second onLoad would
  // start a second withTiming on top of one already in flight.
  const incomingLoadTriggeredRef = useRef(false);
  // Set the instant the top layer finishes fading in and activeUri is
  // switched to match it — cleared once the BOTTOM layer's own onLoad (or
  // onError) resolves that switch, or on any pause/reset/unmount. While
  // this is non-null, the top layer stays at full opacity (still covering
  // the bottom layer) even though its own fade already finished, so the
  // hand-off from top-layer-visible to bottom-layer-visible never exposes
  // a not-yet-repainted (or still-previous-image) bottom layer. The next
  // rotation tick is scheduled ONLY from wherever this gets cleared to a
  // resolved state (revealCommittedActive / handleActiveError) — never
  // independently from the fade-completion callback — so a new tick can
  // structurally never start while a reveal is still pending.
  const pendingRevealUriRef = useRef<string | null>(null);

  const topOpacity = useSharedValue(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasStartedRef = useRef(false);
  const shouldAnimateRef = useRef(false);
  // Set by the scheduling effect below on every run — lets the onLoad/
  // onError handlers (bound in JSX, outside that effect) continue the
  // self-rescheduling chain without duplicating scheduling logic.
  const scheduleTickRef = useRef<((delay: number) => void) | null>(null);

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

  const shouldAnimate = isRouteFocused && isAppActive && !reducedMotion && usableImages.length > 1;

  // Single effect drives both reconciliation and scheduling, re-running
  // whenever shouldAnimate flips OR usableImages changes identity (a
  // source went broken, the slot's previewImageIds refreshed, the slot
  // itself changed). Every run starts by tearing down any in-flight
  // transition unconditionally — a fade that started against the OLD
  // list must never be allowed to land (commit or even keep rendering)
  // against a list that's since changed underneath it — then reconciles
  // activeUri: kept as-is if still present in the new list, otherwise
  // falls back to the new list's first image (or null).
  useEffect(() => {
    shouldAnimateRef.current = shouldAnimate;

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    cancelAnimation(topOpacity);
    topOpacity.value = 0;
    setIncomingUri(null);
    pendingRevealUriRef.current = null;

    setActiveUri((prevActive) => {
      if (prevActive && usableImages.includes(prevActive)) return prevActive;
      return usableImages[0] ?? null;
    });

    if (!shouldAnimate) {
      scheduleTickRef.current = null;
      return;
    }

    function scheduleTick(delay: number) {
      timeoutRef.current = setTimeout(tick, delay);
    }
    scheduleTickRef.current = scheduleTick;

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
          // latest list before even mounting the incoming layer.
          if (!usableImagesRef.current.includes(upcomingUri)) return;
          // Prefetch resolving only means the bytes are cached, not that
          // a freshly-mounted AnimatedExpoImage layer has finished
          // decoding and is ready to paint — the fade itself starts from
          // that layer's own onLoad (handleIncomingLoad below), not here.
          incomingLoadTriggeredRef.current = false;
          setIncomingUri(upcomingUri);
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
      scheduleTickRef.current = null;
      pendingRevealUriRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAnimate, usableImages]);

  const topAnimatedStyle = useAnimatedStyle(() => ({ opacity: topOpacity.value }));

  // Step 1 of the hand-off, called once the top layer's own fade-in has
  // finished: switches the bottom layer's source to the new image while
  // the top layer is still at full opacity covering it. Nothing visually
  // changes yet — the bottom layer repaints "for free" underneath an
  // opaque top layer, so any repaint lag is invisible. Deliberately does
  // NOT schedule the next tick — that only ever happens once the bottom
  // layer confirms the hand-off (revealCommittedActive) or fails it
  // (handleActiveError), never independently from here.
  const beginReveal = useCallback((landedUri: string) => {
    if (!mountedRef.current) return;
    pendingRevealUriRef.current = landedUri;
    setActiveUri(landedUri);
  }, []);

  // Step 2 of the hand-off, called from the BOTTOM layer's own onLoad —
  // only once the bottom layer has actually repainted with the new image
  // is the top layer dropped, and only then is the next rotation tick
  // scheduled. Doing the reveal unconditionally in the same tick as
  // beginReveal (rather than waiting for confirmation) was the cause of
  // the "stutter after the photo settles": the top layer could disappear
  // a frame before the bottom layer had actually finished repainting,
  // briefly exposing the previous image underneath. Runs on the JS thread
  // already (a normal onLoad prop, not a worklet callback), so no runOnJS
  // wrapping is needed to reach scheduleTickRef here.
  const revealCommittedActive = useCallback((uri: string) => {
    if (!mountedRef.current) return;
    if (pendingRevealUriRef.current !== uri) return; // superseded or already resolved
    pendingRevealUriRef.current = null;
    setIncomingUri(null);
    cancelAnimation(topOpacity);
    topOpacity.value = 0;
    scheduleTickRef.current?.(HOLD_DURATION_MS);
  }, [topOpacity]);

  // Starts the crossfade only once the incoming layer has actually
  // finished decoding and is ready to paint — Image.prefetch resolving
  // (in tick(), above) only guarantees the bytes are cached, not that
  // this specific mounted layer is visually ready.
  const handleIncomingLoad = useCallback(
    (uri: string) => {
      if (incomingLoadTriggeredRef.current) return;
      if (!mountedRef.current || !shouldAnimateRef.current) return;
      if (incomingUriRef.current !== uri) return; // superseded by a newer/cleared incoming image
      if (!usableImagesRef.current.includes(uri)) return; // gone broken/removed since it started loading
      incomingLoadTriggeredRef.current = true;
      topOpacity.value = withTiming(1, { duration: FADE_DURATION_MS }, (finished) => {
        if (finished) {
          runOnJS(beginReveal)(uri);
        }
      });
    },
    [beginReveal, topOpacity],
  );

  const handleIncomingError = useCallback(
    (uri: string) => {
      markBroken(uri);
      if (incomingUriRef.current === uri) {
        setIncomingUri(null);
      }
      cancelAnimation(topOpacity);
      topOpacity.value = 0;
      // No manual reschedule here — markBroken updates brokenUrls, which
      // usableImages (and therefore the scheduling effect above) depends
      // on, so that effect tears down and reschedules a fresh attempt on
      // its own. The failed image is never committed as activeUri.
    },
    [markBroken, topOpacity],
  );

  // If the BOTTOM layer itself fails to load the image beginReveal just
  // committed to it, the hand-off can never confirm via
  // revealCommittedActive — without this, the top layer would stay
  // opaque forever and the slideshow would never reschedule its next
  // tick. Clears the pending reveal and the top layer immediately (not
  // waiting on the effect rerun triggered by markBroken below) so nothing
  // is left visibly stuck, and — like handleIncomingError — relies on the
  // usableImages change from markBroken to retrigger the scheduling
  // effect's own teardown-and-reschedule rather than scheduling here
  // directly.
  const handleActiveError = useCallback(
    (uri: string) => {
      markBroken(uri);
      if (pendingRevealUriRef.current === uri) {
        pendingRevealUriRef.current = null;
        setIncomingUri(null);
        cancelAnimation(topOpacity);
        topOpacity.value = 0;
      }
    },
    [markBroken, topOpacity],
  );

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
        // Background simplification pass (Profile V3) — the dashed border
        // + "+" icon that used to mark an owner-addable empty slot are
        // removed; the slot itself is still tappable (isInteractive/
        // canPressEmpty above are unchanged), it just has no visual
        // affordance drawing attention to it for now. Same plain fill for
        // owner and visitor, where previously only the visitor got this.
        <View style={styles.slotEmpty} />
      ) : missingSource ? (
        <View style={styles.slotUnavailable}>
          <Text style={styles.unavailableText}>Unavailable</Text>
        </View>
      ) : slot.entry_type === 'item' ? (
        <View style={styles.itemWrap}>
          {slot.item!.primary_image_id && signedImageUrls.get(slot.item!.primary_image_id) ? (
            <Image
              source={{
                uri: signedImageUrls.get(slot.item!.primary_image_id!),
                cacheKey: itemImageCacheKey(identity, slot.item!.primary_image_id!),
              }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={150}
              cachePolicy="memory-disk"
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
                source={{ uri: activeUri, cacheKey: idByUri.get(activeUri) ? itemImageCacheKey(identity, idByUri.get(activeUri)!) : undefined }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                cachePolicy="memory-disk"
                onLoad={() => revealCommittedActive(activeUri)}
                onError={() => handleActiveError(activeUri)}
              />
              {incomingUri && (
                <AnimatedExpoImage
                  source={{
                    uri: incomingUri,
                    cacheKey: idByUri.get(incomingUri) ? itemImageCacheKey(identity, idByUri.get(incomingUri)!) : undefined,
                  }}
                  style={[StyleSheet.absoluteFill, topAnimatedStyle]}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  onLoad={() => handleIncomingLoad(incomingUri)}
                  onError={() => handleIncomingError(incomingUri)}
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
  // Square, 90°-cornered tile (borderRadius: 0) — matches the same
  // Instagram-style treatment now used by the folder card grid, the
  // Collections preview rows, and the single item image presentation. A
  // Grail-local override (a plain literal here, not a shared constant), so
  // this only affects this grid, not those other surfaces. No border was
  // ever set on this style — the clip boundary is purely overflow:hidden
  // + this radius, nothing else contributing a "framed" look to remove.
  // Shared by every slot state (empty, unavailable, item, collection) via
  // this one Pressable style, so all of them read as uniformly
  // square-cornered — no separate placeholder radius to reconcile.
  slot: {
    flex: 1,
    aspectRatio: CARD_ASPECT_RATIO,
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: PV2.emptyCardBg,
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
