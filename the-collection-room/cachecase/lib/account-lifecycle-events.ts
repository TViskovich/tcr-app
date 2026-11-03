// A tiny signal from anywhere in the app ("the server just said this
// account is inactive") to the AccountLifecycleProvider, which re-checks the
// account's state. Kept separate from lib/account-lifecycle.tsx so error
// helpers can import it without pulling in React.

type Listener = () => void;
const listeners = new Set<Listener>();

export function onAccountInactive(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyAccountInactive() {
  for (const listener of listeners) listener();
}
