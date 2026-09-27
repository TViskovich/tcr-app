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
