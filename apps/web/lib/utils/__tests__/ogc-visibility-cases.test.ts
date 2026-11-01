import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { evaluateCondition, isInputVisible } from "@/lib/utils/ogc-utils";

import type { ProcessedInput, UIFieldMeta } from "@/types/map/ogc-processes";

/**
 * Two kinds of case: a bare `condition` for the condition evaluator, or a
 * setting's `x_ui` (null for none) for the whole visibility rule
 * (`hidden`, `visible_when`, `hidden_when`).
 */
type VisibilityCase = {
  note: string;
  condition?: Record<string, unknown>;
  x_ui?: Record<string, unknown> | null;
  values: Record<string, unknown>;
  expected: boolean;
};

/**
 * The cases goatlib's port of this evaluator (`goatlib/workflows/visibility.py`)
 * is tested with. Both sides read the same file, so the editor and the
 * server's checks agree on which settings are shown.
 */
const CASES_FILE = path.join(
  __dirname,
  "../../../../../packages/python/goatlib/src/goatlib/workflows/visibility_cases.json"
);
const cases = JSON.parse(readFileSync(CASES_FILE, "utf8")) as VisibilityCase[];

const evaluate = (c: VisibilityCase): boolean =>
  "x_ui" in c
    ? isInputVisible({ uiMeta: (c.x_ui ?? undefined) as UIFieldMeta | undefined } as ProcessedInput, c.values)
    : evaluateCondition(c.condition ?? {}, c.values);

describe("visibility conditions shared with goatlib", () => {
  it("has cases of both kinds to run", () => {
    expect(cases.some((c) => "x_ui" in c)).toBe(true);
    expect(cases.some((c) => !("x_ui" in c))).toBe(true);
  });

  it.each(cases.map((c) => [c.note, c] as const))("%s", (_note, c) => {
    expect(evaluate(c)).toBe(c.expected);
  });
});
