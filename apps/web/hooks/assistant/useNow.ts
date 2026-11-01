import { useEffect, useState } from "react";

/** How often the times under the messages are brought up to date. */
export const NOW_TICK_MS = 30_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** One interval for every reader: it starts with the first and stops when the last one leaves. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => listeners.forEach((notify) => notify()), NOW_TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current time in epoch milliseconds, read again on every shared tick. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => subscribe(() => setNow(Date.now())), []);
  return now;
}
