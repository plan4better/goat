import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import { TEMPORAL_DISPLAY_FORMAT } from "@p4b/ui/components/temporalFormats";

import type { FieldKind } from "@/lib/validations/layer";

dayjs.extend(utc);

type DisplayConfig = {
  decimals?: "auto" | number;
  unit?: string;
  thousands_separator?: boolean;
  abbreviate?: boolean;
  always_show_sign?: boolean;
  /** The value as a percent of 1 (0.73 reads 73 %), in the reader's language. */
  percent?: boolean;
  format?: string;
};

const AREA_AUTO_THRESHOLDS: { from: number; unit: string; factor: number }[] = [
  { from: 1_000_000, unit: "km²", factor: 1_000_000 },
  { from: 10_000, unit: "ha", factor: 10_000 },
  { from: 0, unit: "m²", factor: 1 },
];

const LENGTH_AUTO_THRESHOLDS: {
  from: number;
  unit: string;
  factor: number;
}[] = [
  { from: 1000, unit: "km", factor: 1000 },
  { from: 0, unit: "m", factor: 1 },
];

const AREA_FACTORS: Record<string, number> = {
  "mm²": 1e-6,
  "cm²": 1e-4,
  "m²": 1,
  ha: 1e4,
  "km²": 1e6,
};

const LENGTH_FACTORS: Record<string, number> = {
  mm: 1e-3,
  cm: 1e-2,
  m: 1,
  km: 1e3,
};

function pickAuto(
  value: number,
  table: { from: number; unit: string; factor: number }[]
) {
  for (const row of table) {
    if (Math.abs(value) >= row.from) return row;
  }
  return table[table.length - 1];
}

function formatNumber(
  value: number,
  cfg: DisplayConfig,
  defaultDecimals = 2,
  naturalForUndefined = false
): string {
  let decimals: number;
  if (cfg.decimals === undefined) {
    decimals =
      naturalForUndefined && Number.isInteger(value) ? 0 : defaultDecimals;
  } else if (cfg.decimals === "auto") {
    decimals = defaultDecimals;
  } else {
    decimals = cfg.decimals;
  }

  if (cfg.abbreviate) {
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  }

  let s = value.toFixed(decimals);
  if (cfg.thousands_separator) {
    const [intPart, fracPart] = s.split(".");
    const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    s = fracPart !== undefined ? `${withSep}.${fracPart}` : withSep;
  }
  if (cfg.always_show_sign && value > 0) s = `+${s}`;
  return s;
}

export function formatFieldValue(
  value: unknown,
  kind: FieldKind,
  cfg: DisplayConfig,
  /** The reader's language, for a percent. */
  locale?: string
): string {
  if (value === null || value === undefined) return "";

  // A serial number and a UUID are identifiers: shown exactly as stored, never
  // with decimals, separators or abbreviation ("1.2K" would be a different id).
  if (kind === "string" || kind === "serial" || kind === "uuid") return String(value);

  if (kind === "boolean") {
    if (value === true) return "True";
    if (value === false) return "False";
    return String(value);
  }

  if (kind === "datetime") {
    // Render in UTC so the wall time matches the stored value and the filter
    // literals (backend session tz is pinned to UTC), identically for every
    // viewer — never in the browser's local timezone.
    const parsed = dayjs.utc(value as string | number | Date);
    if (!parsed.isValid()) return String(value);
    return parsed.format(cfg.format ?? TEMPORAL_DISPLAY_FORMAT);
  }

  if (typeof value !== "number" || Number.isNaN(value)) return String(value);

  if (kind === "number") {
    if (cfg.percent) {
      const digits =
        typeof cfg.decimals === "number"
          ? { minimumFractionDigits: cfg.decimals, maximumFractionDigits: cfg.decimals }
          : {};
      const text = new Intl.NumberFormat(locale, {
        style: "percent",
        useGrouping: !!cfg.thousands_separator,
        ...digits,
      }).format(value);
      return cfg.always_show_sign && value > 0 ? `+${text}` : text;
    }
    return formatNumber(value, cfg, 2, true);
  }

  // Only the dimensioned kinds get unit formatting; anything else (including
  // an unresolved "formula" kind — callers should resolve it to the formula's
  // output kind first) falls back to the raw value.
  if (kind !== "area" && kind !== "perimeter" && kind !== "length") {
    return String(value);
  }

  // Dimensioned kinds: area, perimeter, length
  const isArea = kind === "area";
  const factors = isArea ? AREA_FACTORS : LENGTH_FACTORS;
  const autoTable = isArea ? AREA_AUTO_THRESHOLDS : LENGTH_AUTO_THRESHOLDS;

  const requestedUnit = cfg.unit ?? "auto";
  let unit: string;
  let displayValue: number;

  if (requestedUnit === "auto") {
    const row = pickAuto(value, autoTable);
    unit = row.unit;
    displayValue = value / row.factor;
  } else {
    unit = requestedUnit;
    const factor = factors[requestedUnit] ?? 1;
    displayValue = value / factor;
  }

  return `${formatNumber(displayValue, cfg)} ${unit}`;
}
