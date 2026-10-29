/**
 * One value of the playback clock's frames, for a component that shows it.
 * The clock ticks many times a second; a component re-renders only when what
 * it reads changes — the minute for a clock, the count for a figure — so
 * `select` returns a primitive or a value the clock keeps (its span).
 */
import { useSyncExternalStore } from "react";

import { type PlaybackFrame, playbackClock } from "@/lib/explorer/playback";

export function usePlaybackValue<T>(select: (frame: PlaybackFrame) => T): T {
  const read = () => select(playbackClock.getSnapshot());
  return useSyncExternalStore(playbackClock.subscribe, read, read);
}
