// Band formulas (spec 9.3) as goatlib's `raster/formula.py` reads them: `b1`, `b2`, ... (a band, from 1), numbers,
// `+ - * /`, brackets and unary minus. The panel checks a typed formula by the same rules before it writes it (the cases
// in goatlib's `tests/unit/raster/fixtures/formulas.json` hold for both), and offers the common indices as presets:
// normalized differences of two bands, which the file's color interpretation or band names may name.
import type { TFunction } from "i18next";

import { isObject } from "@/lib/style/json";
import { type RasterInfo, bandLabel, valueBands } from "@/lib/style/raster/metadata";

/** goatlib `MAX_LENGTH` and `MAX_DEPTH`: long or deeply nested formulas are refused. */
export const MAX_FORMULA_LENGTH = 500;
const MAX_DEPTH = 32;

/** What is wrong with a formula, as goatlib's `FormulaError` says it; `no_such_band` where it names a band the file
 * holds no values in (beyond its bands, or its alpha band). */
export type FormulaProblem =
  | { code: "empty" }
  | { code: "too_long"; max: number }
  | { code: "unexpected_at"; position: number }
  | { code: "unexpected"; text: string }
  | { code: "ends_early" }
  | { code: "bracket" }
  | { code: "nested" }
  | { code: "band_from_one" }
  | { code: "no_band" }
  | { code: "no_such_band"; bands: number[] };

export type FormulaCheck = { ok: true; bands: number[] } | { ok: false; problem: FormulaProblem };

type Token = ["band" | "number" | "op", string];

class Refused extends Error {
  constructor(readonly problem: FormulaProblem) {
    super(problem.code);
  }
}

function tokens(expression: string): Token[] {
  const out: Token[] = [];
  // Sticky: each token where the last ended (goatlib's `re.match` at a position).
  const pattern = new RegExp(String.raw`\s*(?:(b\d+)|(\d+(?:\.\d+)?)|([-+*/()]))`, "y");
  let pos = 0;
  while (pos < expression.length) {
    if (expression.slice(pos).trim() === "") break;
    pattern.lastIndex = pos;
    const m = pattern.exec(expression);
    if (!m) throw new Refused({ code: "unexpected_at", position: pos + 1 });
    out.push(m[1] ? ["band", m[1]] : m[2] ? ["number", m[2]] : ["op", m[3]]);
    pos = pattern.lastIndex;
  }
  return out;
}

/** goatlib's parser step for step (the same depth for brackets and unary minus); collects the bands it names. */
class Parser {
  pos = 0;
  readonly bands = new Set<number>();
  constructor(readonly tokens: Token[]) {}

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  take(): Token {
    const token = this.peek();
    if (!token) throw new Refused({ code: "ends_early" });
    this.pos += 1;
    return token;
  }

  isOp(token: Token | undefined, ...ops: string[]): boolean {
    return token?.[0] === "op" && ops.includes(token[1]);
  }

  expression(depth: number): void {
    this.term(depth);
    while (this.isOp(this.peek(), "+", "-")) {
      this.pos += 1;
      this.term(depth);
    }
  }

  term(depth: number): void {
    this.factor(depth);
    while (this.isOp(this.peek(), "*", "/")) {
      this.pos += 1;
      this.factor(depth);
    }
  }

  factor(depth: number): void {
    if (depth > MAX_DEPTH) throw new Refused({ code: "nested" });
    const [kind, text] = this.take();
    if (kind === "band") {
      const index = parseInt(text.slice(1), 10);
      if (index < 1) throw new Refused({ code: "band_from_one" });
      this.bands.add(index);
      return;
    }
    if (kind === "number") return;
    if (text === "-") return this.factor(depth + 1);
    if (text === "(") {
      this.expression(depth + 1);
      const close = this.take();
      if (!this.isOp(close, ")")) throw new Refused({ code: "bracket" });
      return;
    }
    throw new Refused({ code: "unexpected", text });
  }
}

/** Whether `expression` is a band formula (goatlib `parse_formula`), and the bands it names, sorted. With `held` (the
 * file's bands of values, `valueBands`), a band outside them is refused, as the style check refuses it. */
export function checkFormula(expression: string, held?: readonly number[]): FormulaCheck {
  try {
    if (!expression.trim()) throw new Refused({ code: "empty" });
    if (expression.length > MAX_FORMULA_LENGTH)
      throw new Refused({ code: "too_long", max: MAX_FORMULA_LENGTH });
    const parser = new Parser(tokens(expression));
    parser.expression(0);
    const rest = parser.peek();
    if (rest) throw new Refused({ code: "unexpected", text: rest[1] });
    const bands = [...parser.bands].sort((a, b) => a - b);
    if (!bands.length) throw new Refused({ code: "no_band" });
    if (held && bands.some((b) => !held.includes(b)))
      throw new Refused({ code: "no_such_band", bands: [...held] });
    return { ok: true, bands };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, problem: error.problem };
    throw error;
  }
}

/** A formula problem in the reader's language. */
export function formulaProblemText(problem: FormulaProblem, t: TFunction): string {
  const { code, ...values } = problem;
  const shown =
    problem.code === "no_such_band" ? { bands: problem.bands.map((b) => `b${b}`).join(", ") } : values;
  // The typed text as it is: React escapes it, i18next must not as well.
  return t(`style_editor.formula_${code}`, { ...shown, interpolation: { escapeValue: false } });
}

/** What a preset's input band is: the file's color interpretation (GDAL) or band names may say it. */
export type BandRole = "red" | "green" | "nir" | "swir1";

export interface FormulaPreset {
  id: "ndvi" | "ndmi" | "ndwi";
  /** The index's name, written as the formula's `name` (the popup's label for the value). */
  name: string;
  /** The normalized difference's bands, in order: (first - second) / (first + second). */
  inputs: [BandRole, BandRole];
  /** The palette a new index starts with, over `PRESET_DOMAIN`: diverging, centred on 0. */
  palette: string;
}

/** The common normalized difference indices (vegetation, moisture, water). */
export const FORMULA_PRESETS: readonly FormulaPreset[] = [
  { id: "ndvi", name: "NDVI", inputs: ["nir", "red"], palette: "colorbrewer:RdYlGn" },
  { id: "ndmi", name: "NDMI", inputs: ["nir", "swir1"], palette: "colorbrewer:RdYlBu" },
  { id: "ndwi", name: "NDWI", inputs: ["green", "nir"], palette: "colorbrewer:BrBG" },
];

/** Every normalized difference lies between -1 and 1: one range, so indices compare across images. */
export const PRESET_DOMAIN: [number, number] = [-1, 1];

/** The formula of a normalized difference of bands `a` and `b`. */
export const normalizedDifference = (a: number, b: number): string => `(b${a} - b${b}) / (b${a} + b${b})`;

/** What a render's `band` reads: a band number (1 without one), or a band formula's expression (what the info is
 * asked for, `statsOf`). */
export function bandOrFormula(band: unknown): number | string {
  return formulaOf(band)?.expression ?? (typeof band === "number" ? band : 1);
}

/** A band formula of a style (`render.band`), or null for a band number. */
export function formulaOf(band: unknown): { name: string; expression: string } | null {
  if (!isObject(band) || typeof band.expression !== "string" || !band.expression.trim()) return null;
  return { name: typeof band.name === "string" ? band.name : "", expression: band.expression };
}

/** The preset a band formula is, with its two bands: its name is the preset's and its expression that preset's
 * normalized difference (the three presets share one shape, so only the name tells them apart); null otherwise. */
export function presetOf(band: unknown): { preset: FormulaPreset; bands: [number, number] } | null {
  const formula = formulaOf(band);
  if (!formula) return null;
  const preset = FORMULA_PRESETS.find((p) => p.name.toLowerCase() === formula.name.trim().toLowerCase());
  const m = /^\(b(\d+)-b(\d+)\)\/\(b(\d+)\+b(\d+)\)$/.exec(formula.expression.replace(/\s+/g, ""));
  if (!preset || !m) return null;
  const [a, b, c, d] = m.slice(1).map(Number);
  const sum = (c === a && d === b) || (c === b && d === a);
  return sum && a !== b ? { preset, bands: [a, b] } : null;
}

/** The roles the file's color interpretation names (GDAL 3.10: `nir`, `swir`, ...): a second band marked `swir` is the
 * longer wavelength, so the first is SWIR 1. */
const INTERP_ROLES: Record<string, BandRole> = { red: "red", green: "green", nir: "nir", swir: "swir1" };

/** A band name's words, lower-case. */
const NOT_A_WORD = new RegExp(String.raw`[^\p{L}\p{N}]+`, "u");
const words = (name: string): string[] => name.toLowerCase().split(NOT_A_WORD).filter(Boolean);

/** Whether the file names its bands by Sentinel-2's band codes: one of them is B8A or B12, which the numbering of
 * other sensors does not have (a Landsat stack runs B1 to B11, its B8 panchromatic and its B11 thermal). */
const sentinelCodes = (names: readonly string[] | undefined): boolean =>
  !!names?.some((name) => {
    const w = words(name);
    return w.length === 1 && /^b(0?8a|12)$/.test(w[0]);
  });

/** The role a band's name gives it: the color or wavelength in words (English or German, STAC's common names), on any
 * file; with `codes` (a file of Sentinel-2's band codes, `sentinelCodes`) also a band's code alone (B4 red, B3 green,
 * B8 and B8A near infrared, B11 SWIR 1). */
function nameRole(name: string, codes: boolean): BandRole | undefined {
  const w = words(name);
  const code = codes && w.length === 1 ? w[0] : "";
  const has = (...any: string[]) => any.some((x) => w.includes(x));
  if (
    has("nir", "nir08") ||
    (has("infrared", "infrarot") && has("near", "nahes", "nah")) ||
    /^b0?8a?$/.test(code)
  )
    return "nir";
  if (has("swir1", "swir16") || (has("swir") && w[w.indexOf("swir") + 1] === "1") || code === "b11")
    return "swir1";
  if (has("edge", "rededge")) return undefined;
  if (has("red", "rot") || /^b0?4$/.test(code)) return "red";
  if (has("green", "grün", "gruen") || /^b0?3$/.test(code)) return "green";
  return undefined;
}

/** The band of values the file names for `role`: the first its color interpretation marks so, else the first whose
 * name says so (a bare band code only among Sentinel-2's, `sentinelCodes`); undefined where none does (the input then
 * waits to be picked). */
export function roleBand(info: RasterInfo | undefined, role: BandRole): number | undefined {
  const held = valueBands(info);
  const marked = held.find((b) => INTERP_ROLES[info?.colorInterp?.[b - 1] ?? ""] === role);
  if (marked !== undefined) return marked;
  const codes = sentinelCodes(info?.names);
  return held.find((b) => nameRole(info?.names?.[b - 1] ?? "", codes) === role);
}

/** A preset's input bands as the file names them (`roleBand`), in the preset's order. */
export function presetBands(
  info: RasterInfo | undefined,
  preset: FormulaPreset
): [number | undefined, number | undefined] {
  return [roleBand(info, preset.inputs[0]), roleBand(info, preset.inputs[1])];
}

/** How the Band row names a band formula: a preset by its name and its bands as the file names them ("NDVI (B8, B4)"),
 * any other formula by its expression; undefined for a band number. */
export function formulaLabel(band: unknown, info: RasterInfo | undefined, t: TFunction): string | undefined {
  const found = presetOf(band);
  if (found) return `${found.preset.name} (${found.bands.map((b) => bandLabel(info, b, t)).join(", ")})`;
  return formulaOf(band)?.expression.trim();
}
