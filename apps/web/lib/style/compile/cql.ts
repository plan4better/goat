// CQL2-JSON conditions of rules (spec 6, 18.6) as MapLibre expressions.
import type { Expr } from "@/lib/style/compile/values";
import { isObject } from "@/lib/style/json";

const COMPARE: Record<string, string> = { "=": "==", "<>": "!=", "<": "<", ">": ">", "<=": "<=", ">=": ">=" };

const property = (arg: unknown): string | null =>
  isObject(arg) && typeof arg.property === "string" ? arg.property : null;

/** A `like` pattern: `%x%` contains, `x%` starts with, `%x` ends with, otherwise equals. */
function like(field: string, pattern: string): Expr {
  const s: Expr = ["to-string", ["get", field]];
  const starts = pattern.startsWith("%");
  const ends = pattern.endsWith("%") && pattern.length > 1;
  const text = pattern.slice(starts ? 1 : 0, ends ? -1 : undefined);
  if (starts && ends) return ["in", text, s];
  if (ends) return ["==", ["slice", s, 0, text.length], text];
  if (starts) return ["==", ["slice", s, ["-", ["length", s], text.length]], text];
  return ["==", s, text];
}

/** The condition as a boolean expression; null for a condition the models would refuse. */
export function cqlToExpression(when: unknown): Expr | null {
  if (!isObject(when) || !Array.isArray(when.args)) return null;
  const { op, args } = when;
  if (op === "and" || op === "or") {
    const parts = args.map(cqlToExpression);
    return parts.length && parts.every((p) => p !== null) ? [op === "and" ? "all" : "any", ...parts] : null;
  }
  if (op === "not") {
    const inner = cqlToExpression(args[0]);
    return inner === null ? null : ["!", inner];
  }
  const field = property(args[0]);
  if (field === null) return null;
  if (op === "isNull") return ["!", ["has", field]];
  if (op === "in") return Array.isArray(args[1]) ? ["in", ["get", field], ["literal", args[1]]] : null;
  if (op === "like") return typeof args[1] === "string" ? like(field, args[1]) : null;
  if (typeof op === "string" && op in COMPARE) {
    const compare: Expr = [COMPARE[op], ["get", field], args[1]];
    if (op === "=" || op === "<>") return compare;
    // An order comparison asserts the value's type in MapLibre, and a missing or differently typed value ends the
    // evaluation (a hidden feature, a default color): such features compare false. Booleans have no order.
    const type = typeof args[1];
    if (type !== "number" && type !== "string") return false;
    return ["all", ["==", ["typeof", ["get", field]], type], compare];
  }
  return null;
}
