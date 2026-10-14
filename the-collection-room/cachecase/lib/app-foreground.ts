import { useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

// A counter that increments each time the app returns to the foreground
// ('active' after 'background'/'inactive'). The signed-URL hooks
// (use-signed-item-images / use-signed-folder-covers) put it in their fetch
// effect's dependencies, so a screen that stayed mounted while the app was
// backgrounded re-checks its signed URLs on return — their 300s lifetime
// may have passed while JS timers were paused, and nothing else about a
// still-mounted screen changes on foreground to make it look again.
//
// One app-wide AppState subscription, created on first use and kept for
// the process lifetime; each hook instance only adds a listener.

let generation = 0;
let lastState: AppStateStatus = AppState.currentState;
let subscribed = false;
const listeners = new Set<() => void>();

function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  AppState.addEventListener('change', (next) => {
    const wasActive = lastState === 'active';
    lastState = next;
    if (next === 'active' && !wasActive) {
      generation += 1;
      for (const listener of listeners) listener();
    }
  });
}

function subscribe(listener: () => void) {
  ensureSubscribed();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getGeneration() {
  return generation;
}

export function useForegroundGeneration(): number {
  return useSyncExternalStore(subscribe, getGeneration, getGeneration);
}
