/**
 * The assumptions the Explorer's figures rest on, set per bundle by the user:
 * cost rates per operator and route type (board 15), the time periods
 * headways and running times are given for, and the layover that estimates
 * vehicles where a feed has no blocks.
 *
 * Kept in this browser for now (Nihar, 14 Oct 2026); keyed by GTFS ids, not a
 * snapshot's indices, so they survive a rebuild of the snapshot.
 */
import { type ModeKey, modeOf } from "@/lib/explorer/modes";

export interface Rate {
  per_km: number;
  /** Empty means the km rate is all-in. */
  per_hour: number | null;
}

export interface Period {
  key: string;
  /** Seconds since the start of the service day; `end_s` exclusive. */
  start_s: number;
  end_s: number;
}

/** The periods' keys, in order; each is named in the locale files. */
export const PERIOD_KEYS = ["early", "am_peak", "midday", "pm_peak", "evening", "night"] as const;

/** The service day the periods cover: to 48:00, as a feed's times may run. */
export const SERVICE_DAY_END_S = 48 * 3600;

export interface ExplorerSettings {
  currency: string;
  /** Set rates by `rateKey(agency_id, route_type)`; any other uses the default. */
  rates: Record<string, Rate>;
  /** Contiguous, from 0 to SERVICE_DAY_END_S, in PERIOD_KEYS order. */
  periods: Period[];
  layover_s: number;
}

export const CURRENCIES = ["EUR", "CHF", "GBP", "USD"];

/** Every ISO 4217 currency the browser knows, the common ones first; the
 * short list where it cannot say. */
export function allCurrencies(): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : CURRENCIES;
  return [...CURRENCIES, ...all.filter((c) => !CURRENCIES.includes(c))];
}

/** Where nothing is set: common planning hours. */
export function periodsFrom(boundaries: number[]): Period[] {
  const edges = [0, ...boundaries, SERVICE_DAY_END_S];
  return PERIOD_KEYS.map((key, i) => ({ key, start_s: edges[i], end_s: edges[i + 1] }));
}

export const DEFAULT_SETTINGS: ExplorerSettings = {
  currency: "EUR",
  rates: {},
  periods: periodsFrom([7, 9, 15, 18, 22].map((h) => h * 3600)),
  layover_s: 6 * 60,
};

/** Default rate by kind of vehicle, where none is set. */
export function modeRate(mode: ModeKey): Rate {
  if (mode === "tram" || mode === "cable_tram" || mode === "trolleybus") return { per_km: 7, per_hour: null };
  if (mode === "metro" || mode === "rail" || mode === "monorail") return { per_km: 12, per_hour: null };
  return { per_km: 4.5, per_hour: null };
}

/** Default rate by GTFS route type (basic or extended), where none is set. */
export function defaultRate(routeType: number | null): Rate {
  return modeRate(modeOf(routeType ?? 3));
}

/** The kind of vehicle a rate key is for. */
export function rateKeyMode(key: string): ModeKey {
  return key.slice(key.lastIndexOf("|") + 1) as ModeKey;
}

/** Rates as kept, each under its kind of vehicle: one kept per route type
 * (before 21 Oct 2026) moves to its kind's key, unless that has one. */
export function ratesByKind(rates: Record<string, Rate>): Record<string, Rate> {
  const out: Record<string, Rate> = {};
  for (const [key, rate] of Object.entries(rates)) {
    const bar = key.lastIndexOf("|");
    const tail = key.slice(bar + 1);
    if (tail === "" || /^\d+$/.test(tail)) {
      const kind = rateKey(key.slice(0, bar) || null, tail === "" ? null : Number(tail));
      out[kind] ??= rate;
    } else out[key] = rate;
  }
  return out;
}

/** A rate is set per operator and kind of vehicle (bus, tram, …), not per
 * GTFS route type: a feed often gives one kind several types (3 and 700
 * both buses, 0 and 900 both trams), all costing the same. */
export function rateKey(agencyId: string | null, routeType: number | null): string {
  return `${agencyId ?? ""}|${modeOf(routeType ?? 3)}`;
}

/** Rates kept before they were per kind of vehicle were per route type
 * (until 21 Oct 2026): still read, where no rate for the kind is set. */
const typeKey = (agencyId: string | null, routeType: number | null) => `${agencyId ?? ""}|${routeType ?? ""}`;

export function rateFor(settings: ExplorerSettings, agencyId: string | null, routeType: number | null): Rate {
  return (
    settings.rates[rateKey(agencyId, routeType)] ??
    settings.rates[typeKey(agencyId, routeType)] ??
    defaultRate(routeType)
  );
}

/** Whether every rate in use is the default. */
export function usesDefaultRates(settings: ExplorerSettings): boolean {
  return Object.keys(settings.rates).length === 0;
}

/** What makes figures differ: a key for caches of answers worked out with them. */
export function settingsKey(settings: ExplorerSettings): string {
  return JSON.stringify([settings.rates, settings.periods.map((p) => p.start_s), settings.layover_s]);
}

/** Problems with a draft, as locale keys: none means it can be saved. */
export function settingsProblems(settings: ExplorerSettings): string[] {
  const problems: string[] = [];
  for (const r of Object.values(settings.rates)) {
    if (
      !(r.per_km >= 0 && r.per_km < 1000) ||
      (r.per_hour !== null && !(r.per_hour >= 0 && r.per_hour < 10000))
    ) {
      problems.push("explorer_settings_rate_range");
      break;
    }
  }
  const starts = settings.periods.map((p) => p.start_s);
  if (starts.some((s, i) => i > 0 && s <= starts[i - 1]) || starts[starts.length - 1] >= SERVICE_DAY_END_S)
    problems.push("explorer_settings_periods_order");
  if (!(settings.layover_s >= 0 && settings.layover_s <= 3600))
    problems.push("explorer_settings_layover_range");
  return problems;
}

const storageKey = (bundleId: string) => `goat.explorer.settings.${bundleId}`;

/** This browser's settings for a bundle; the defaults where none are kept or
 * storage is unavailable. */
export function loadSettings(bundleId: string): ExplorerSettings {
  try {
    const raw = window.localStorage.getItem(storageKey(bundleId));
    if (!raw) return DEFAULT_SETTINGS;
    const saved = JSON.parse(raw) as Partial<ExplorerSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...saved };
    return settingsProblems(merged).length ? DEFAULT_SETTINGS : merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Whether the settings were kept: storage may be full or blocked. */
export function saveSettings(bundleId: string, settings: ExplorerSettings): boolean {
  try {
    window.localStorage.setItem(storageKey(bundleId), JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
