/**
 * The playback clock's frames: the time playback shows and where the
 * network's vehicles are then. Kept outside React and Redux, so a frame
 * reaches only what draws it — the bar's clock and the map — and the panels
 * do not re-render many times a second. The map reads it from outside the
 * Explorer's provider, as it reads the route drawing from the store.
 */
import { type VehicleFrame, vehicleFrame } from "@/lib/explorer/derive/vehicles";

/** How a route's vehicles are drawn: set once per bundle, not per frame. */
export interface VehicleStyle {
  route_id: string;
  /** `#RRGGBB`, the route's or its mode's. */
  color: string;
  /** `#RRGGBB`: the route's number on its colour, as its badge has it. */
  text_color: string;
  /** What the vehicle's badge reads: the route's number. */
  label: string;
}

export interface PlaybackFrame {
  /** Service-day seconds; null before the day's service is known. */
  time_s: number | null;
  /** Each running vehicle where it is at `time_s`: columns filled in place
   * frame after frame, so a reader takes what it needs when it is told. */
  vehicles: VehicleFrame;
  /** Each route's look, by route_idx. */
  styles: Map<number, VehicleStyle>;
  /** The day's first departure and last arrival, which bound the scrubber. */
  span: { first_s: number; last_s: number } | null;
}

const EMPTY: PlaybackFrame = {
  time_s: null,
  vehicles: vehicleFrame(),
  styles: new Map(),
  span: null,
};

let frame: PlaybackFrame = EMPTY;
const listeners = new Set<() => void>();

export const playbackClock = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): PlaybackFrame {
    return frame;
  },
  publish(next: Partial<PlaybackFrame>): void {
    frame = { ...frame, ...next };
    listeners.forEach((l) => l());
  },
  /** No playback: the Explorer closed, or another bundle opened. */
  reset(): void {
    frame = EMPTY;
    listeners.forEach((l) => l());
  },
};
