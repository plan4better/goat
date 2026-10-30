/**
 * The trip strip's measures and window (02-panel-behaviour-spec › Panel
 * regions, Viewers): how tall the bottom bar is in each state, which part of
 * the day the strip shows, and how a click on it moves playback.
 */
import { useEffect, useRef, useState } from "react";

import type { ExplorerStrip } from "@/lib/store/explorer/slice";
import { setPlaybackTime, setPlaying } from "@/lib/store/explorer/slice";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

/** The playback row: the mini bar, and the strip's header. */
export const BAR_HEIGHT = 56;
/** The bottom panel with the strip: as it opens, and how short its top edge
 * drags it. How tall is the room above it on the map (`STRIP_TOP`). */
export const STRIP_HEIGHT = 272;
export const STRIP_MIN = 200;
/** Marks what the strip must stay under, at the map's top (the search and
 * the tools under it, DataProjectLayout); the strip keeps `TOP_GAP` clear. */
export const STRIP_TOP = "data-explorer-strip-top";
const TOP_GAP = 10;
export const STRIP_FOOTER = 40;
const HOUR = 3600;

/** The bar grows upwards from its bottom edge, so opening the strip moves
 * the playback row up by the strip's height less the row's. Kept to whole
 * multiples of this (px), the row lands on whole device pixels at 125, 150
 * and 175 % display scaling as well as 100 and 200 %, and its text and
 * buttons draw exactly as in the mini bar instead of a fraction of a pixel
 * off, softer. */
const ROW_GRID = 4;

/** A strip height within its bounds: `max`, the room above the bar as
 * measured (`stripRoom`), or, unmeasured, the viewport less the header. */
export function clampStripHeight(height: number, max?: number): number {
  const room = max ?? (typeof window === "undefined" ? 900 : window.innerHeight) - 160;
  const h = Math.min(Math.max(height, STRIP_MIN), Math.max(STRIP_MIN, room));
  return BAR_HEIGHT + Math.floor((h - BAR_HEIGHT) / ROW_GRID) * ROW_GRID;
}

/** How tall the bottom panel `panel` can grow: from its bottom edge up to
 * just under what is marked `STRIP_TOP`, or the window's top. */
export function stripRoom(panel: HTMLElement): number {
  const bottom = panel.getBoundingClientRect().bottom;
  const above = document.querySelector(`[${STRIP_TOP}]`)?.getBoundingClientRect().bottom ?? 0;
  return Math.floor(bottom - above - TOP_GAP);
}

/** The bottom bar's height: the strip's while a route is selected and the
 * strip not folded away, else the mini bar's. */
export function bottomBarHeight(strip: ExplorerStrip, routeSelected: boolean): number {
  if (!routeSelected || strip.collapsed) return BAR_HEIGHT;
  return clampStripHeight(strip.height);
}

/** The part of the day the strip shows, `[from, to]` in service-day
 * seconds: the route's whole service (`span`), out to the hour. A closer
 * look is the chart's zoom. */
export function stripWindow(span: { first_s: number; last_s: number } | null): [number, number] {
  const first = span?.first_s ?? 0;
  const last = span?.last_s ?? 24 * HOUR;
  return [Math.floor(first / HOUR) * HOUR, Math.max(Math.ceil(last / HOUR) * HOUR, first + HOUR)];
}

/** Moves playback to a time from the strip, as the scrubber did: playing,
 * it pauses there and plays on from it. */
export function useSeek(): (t: number) => void {
  const dispatch = useAppDispatch();
  const playing = useAppSelector((s) => s.explorer.playing);
  return (t: number) => {
    const at = Math.round(t);
    if (!playing) {
      dispatch(setPlaybackTime(at));
      return;
    }
    // Paused first, so playback stores where it stopped; then the new time,
    // and on from it.
    dispatch(setPlaying(false));
    requestAnimationFrame(() => {
      dispatch(setPlaybackTime(at));
      dispatch(setPlaying(true));
    });
  };
}

/** An element's width, kept current as the layout changes. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
