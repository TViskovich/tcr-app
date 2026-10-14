// Tiny registry so the shared bottom nav can ask the currently focused
// screen to scroll to its top, without the nav knowing anything about that
// screen's scroll refs. A screen registers a handler (keyed by destination)
// while it is focused and unregisters on blur; the nav calls
// requestScrollToTop(key) and gets back whether a handler took it. Purely a
// scroll action — no navigation, no refetch.
const handlers = new Map<string, () => void>();

export function registerScrollToTop(key: string, handler: () => void): () => void {
  handlers.set(key, handler);
  return () => {
    if (handlers.get(key) === handler) handlers.delete(key);
  };
}

export function requestScrollToTop(key: string): boolean {
  const handler = handlers.get(key);
  if (!handler) return false;
  handler();
  return true;
}

// Tab RESELECT — the user tapped the bottom-nav icon of the tab they're
// already on (its root screen). Same register-while-focused shape as
// scroll-to-top above, but the handler decides whether it acted (returns
// true) so the nav can fall back to its normal behavior when it didn't.
// Home uses it to switch Following back to For You.
const reselectHandlers = new Map<string, () => boolean>();

export function registerTabReselect(key: string, handler: () => boolean): () => void {
  reselectHandlers.set(key, handler);
  return () => {
    if (reselectHandlers.get(key) === handler) reselectHandlers.delete(key);
  };
}

export function requestTabReselect(key: string): boolean {
  return reselectHandlers.get(key)?.() ?? false;
}
