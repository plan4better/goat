/**
 * The minute playback stands at, for what the panels mark as "now" (the
 * next departure, the vehicle on a trip). The playback clock ticks many times
 * a second; this changes once a minute, so a panel re-renders no more often.
 */
import { useEffect, useState } from "react";

import { playbackClock } from "@/lib/explorer/playback";

import { useAppSelector } from "@/hooks/store/ContextHooks";

/** Service-day seconds at the start of the minute, or null before the day's
 * service is known. */
export function usePlaybackMinute(): number | null {
  const stored = useAppSelector((s) => s.explorer.time_s);
  const toMinute = (t: number | null | undefined) =>
    t === null || t === undefined ? null : Math.floor(t / 60) * 60;
  const [minute, setMinute] = useState(() => toMinute(playbackClock.getSnapshot().time_s ?? stored));
  useEffect(() => {
    const look = () => {
      const next = toMinute(playbackClock.getSnapshot().time_s ?? stored);
      setMinute((m) => (m === next ? m : next));
    };
    look();
    return playbackClock.subscribe(look);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);
  return minute;
}
