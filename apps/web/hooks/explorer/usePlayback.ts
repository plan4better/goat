/**
 * Playback (02-panel-behaviour-spec › Playback): the network's vehicles at
 * the time playback shows, advancing while it plays.
 *
 * For the Explorer's date it works out the day's runs once, then reads the
 * vehicles' movements a window of the day at a time — the next one before the
 * current runs out — and places them for each frame without the database.
 * Frames go to the playback clock (lib/explorer/playback.ts); the store keeps
 * whether it plays, how fast, and where it stopped.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "react-redux";

import type { SqlRunner } from "@/lib/explorer/db/types";
import {
  type VehicleWindow,
  dropShapeCache,
  positionsAt,
  prepareDay,
  serviceSpan,
  vehicleFrame,
  vehicleWindow,
} from "@/lib/explorer/derive/vehicles";
import { type MemoryVerdict, checkMemory } from "@/lib/explorer/memory";
import { modeOf, routeColor, routeTextColor } from "@/lib/explorer/modes";
import { type PlaybackFrame, type VehicleStyle, playbackClock } from "@/lib/explorer/playback";
import type { RootState } from "@/lib/store";
import { setPlaybackTime, setPlaying } from "@/lib/store/explorer/slice";

import type { RouteRow } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

/** A window of the day read at once, and how long before its end the next
 * is read. At 60× a window lasts 20 s; reading one takes well under one. */
const WINDOW_S = 20 * 60;
const AHEAD_S = 5 * 60;
/** Frames a second sent to the map: smooth enough, and light on it. */
const FRAME_MS = 100;
/** Where playback starts on a day when nothing says otherwise. */
const START_S = 8 * 3600;
/** How often memory is looked at while playing. */
const MEMORY_CHECK_MS = 5000;

/** Plays the network, as long as memory allows: the verdict says whether it
 * may, and why not. */
export function usePlayback(db: SqlRunner | undefined, routes: RouteRow[] | undefined): MemoryVerdict {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const date = useAppSelector((s) => s.explorer.date);
  const playing = useAppSelector((s) => s.explorer.playing);
  const speed = useAppSelector((s) => s.explorer.speed);
  const time_s = useAppSelector((s) => s.explorer.time_s);

  // The current day and its windows, kept across renders.
  const day = useRef<{ date: string; ready: Promise<PlaybackFrame["span"]> } | null>(null);
  const windows = useRef<Map<number, Promise<VehicleWindow>>>(new Map());
  const live = useRef<number | null>(time_s);
  // The frame's columns, filled in place for every frame drawn.
  const frame = useRef(vehicleFrame());
  const [memory, setMemory] = useState<MemoryVerdict>({ ok: true });

  // Playback is a nice-to-have: it starts only with memory to spare, and
  // stops, letting go of what it holds, when memory runs short.
  useEffect(() => {
    if (!db) return;
    let current = true;
    const look = async () => {
      const verdict = await checkMemory(db);
      if (!current) return;
      setMemory(verdict);
      if (!verdict.ok && playing) {
        dispatch(setPlaying(false));
        windows.current = new Map();
        dropShapeCache(db);
      }
    };
    void look();
    const timer = playing ? window.setInterval(look, MEMORY_CHECK_MS) : undefined;
    return () => {
      current = false;
      if (timer) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, playing]);

  // Each route's look, for the map to draw its vehicles with.
  useEffect(() => {
    playbackClock.publish({
      styles: new Map(
        (routes ?? []).map((r): [number, VehicleStyle] => {
          const color = routeColor(r.color, modeOf(r.route_type));
          return [
            r.route_idx,
            {
              route_id: r.route_id,
              color,
              text_color: routeTextColor(r.text_color, color),
              label: r.short_name || r.long_name?.slice(0, 4) || r.route_id,
            },
          ];
        })
      ),
    });
  }, [routes]);

  // A day's runs, once per date; playback starts at 08:00 or the day's first
  // departure, or stays at the time it was at on the day before, if the new
  // day's service runs then.
  useEffect(() => {
    if (!db || !date) return;
    windows.current = new Map();
    const ready = prepareDay(db, date).then(() => serviceSpan(db));
    day.current = { date, ready };
    let current = true;
    ready.then((span) => {
      if (!current) return;
      playbackClock.publish({ span });
      const now = store.getState().explorer.time_s;
      if (span && (now === null || now < span.first_s || now > span.last_s)) {
        const start = START_S >= span.first_s && START_S <= span.last_s ? START_S : span.first_s;
        dispatch(setPlaybackTime(start));
      }
    });
    return () => {
      current = false;
    };
  }, [db, date, dispatch, store]);

  useEffect(() => () => playbackClock.reset(), []);

  /** The window holding `t`, read if need be; the next is read ahead. */
  const windowFor = (t: number): Promise<VehicleWindow> | null => {
    if (!db || !day.current) return null;
    const { date: d, ready } = day.current;
    const index = Math.floor(t / WINDOW_S);
    const read = (i: number) => {
      let w = windows.current.get(i);
      if (!w) {
        w = ready.then(() => vehicleWindow(db, d, i * WINDOW_S, (i + 1) * WINDOW_S));
        w.catch(() => windows.current.delete(i));
        windows.current.set(i, w);
        // Windows long past are let go.
        for (const k of windows.current.keys()) if (k < i - 1) windows.current.delete(k);
      }
      return w;
    };
    if (t > (index + 1) * WINDOW_S - AHEAD_S) void read(index + 1);
    return read(index);
  };

  /** Place the vehicles at `t` and send the frame. */
  const draw = async (t: number) => {
    const w = windowFor(t);
    if (!w) return;
    const window = await w;
    if (live.current !== t) return; // a later frame is on its way
    playbackClock.publish({ time_s: t, vehicles: positionsAt(window, t, frame.current) });
  };

  // Paused: show the time the store holds.
  useEffect(() => {
    if (playing || time_s === null) return;
    live.current = time_s;
    void draw(time_s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, time_s, db, date]);

  // Playing: advance the clock, `speed` seconds of the day each second.
  useEffect(() => {
    if (!playing || time_s === null) return;
    let raf = 0;
    let last = performance.now();
    let sent = 0;
    // From the time the store holds now: where it paused (a speed change
    // stores it on the way), or where the scrubber was let go.
    let t = store.getState().explorer.time_s ?? time_s;
    live.current = t;
    const tick = (now: number) => {
      t += ((now - last) / 1000) * speed;
      last = now;
      const end = playbackClock.getSnapshot().span?.last_s;
      if (end !== undefined && t >= end) {
        live.current = end;
        void draw(end);
        dispatch(setPlaybackTime(end));
        dispatch(setPlaying(false));
        return;
      }
      if (now - sent >= FRAME_MS) {
        sent = now;
        live.current = t;
        void draw(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Where it stopped is where it resumes.
      if (live.current !== null) dispatch(setPlaybackTime(Math.round(live.current)));
    };
    // The clock restarts from the store's time only when play or speed change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed]);

  return memory;
}
