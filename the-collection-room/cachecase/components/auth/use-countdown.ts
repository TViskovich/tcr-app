import { useEffect, useState } from 'react';

// Whole seconds left until `until` (a Date.now() timestamp), refreshed by a
// timer (never computed during render). Used for the password-reset resend
// cooldown.
export function useCountdown(until: number): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    const update = () => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 500);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [until]);
  return left;
}
