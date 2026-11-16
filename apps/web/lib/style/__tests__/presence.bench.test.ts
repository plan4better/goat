// What counting the classes in view costs on a busy view (spec 7.2 `legend.classes: view`): many invented features
// over ten classes, read the way the map hands them over. It prints the time; the bound only catches a count that
// went from a lookup per feature to something much slower.
import { describe, expect, it } from "vitest";

import { countPresence } from "@/lib/style/presence";

const FEATURES = 100_000;
const CLASSES = 10;
const STAMP = { at: "2026-01-01T00:00:00Z", data: "synthetic:1", scope: "dataset" };

const categories = {
  version: 1,
  kind: "vector",
  classify: [
    {
      id: "kind",
      field: "kind",
      method: "categories",
      classes: Array.from({ length: CLASSES }, (_, i) => ({ id: `c${i}`, values: [`kind ${i}`] })),
      other: { marker: { color: "#000000" } },
      computed: { ...STAMP, other: true, no_data: false },
    },
  ],
};

const numeric = {
  version: 1,
  kind: "vector",
  classify: [
    {
      id: "size",
      field: "size",
      method: "manual",
      classes: Array.from({ length: CLASSES }, (_, i) => ({
        id: `c${i}`,
        ...(i > 0 ? { from: i * 10 } : {}),
        ...(i < CLASSES - 1 ? { to: (i + 1) * 10 } : {}),
      })),
      computed: { ...STAMP, other: false, no_data: false },
    },
  ],
};

// The last class has no feature, so the count reads every feature: the most it ever does.
const kinds = Array.from({ length: FEATURES }, (_, i) => ({
  properties: { kind: `kind ${i % (CLASSES - 1)}`, size: (i % ((CLASSES - 1) * 10)) + 0.5 },
}));

function time(run: () => void): number {
  run();
  const runs = 5;
  const start = performance.now();
  for (let i = 0; i < runs; i++) run();
  return (performance.now() - start) / runs;
}

describe("counting the classes in view", () => {
  it("reads many features over ten classes quickly", () => {
    const results: Record<string, number> = {};
    results.categories = time(() => {
      const counter = countPresence(categories);
      expect(counter.add(kinds)).toBe(false);
    });
    results.numeric = time(() => {
      const counter = countPresence(numeric);
      expect(counter.add(kinds)).toBe(false);
    });
    // Every class among the first features: the count stops there.
    const all = [
      { properties: { kind: "other kind" } },
      ...kinds.slice(0, CLASSES),
      { properties: { kind: `kind ${CLASSES - 1}` } },
      ...kinds,
    ];
    results.early = time(() => {
      const counter = countPresence(categories);
      expect(counter.add(all)).toBe(true);
    });
    console.info(
      `legend classes in view, ${FEATURES} features, ${CLASSES} classes: ` +
        Object.entries(results)
          .map(([name, ms]) => `${name} ${ms.toFixed(2)} ms`)
          .join(", ")
    );
    expect(results.categories).toBeLessThan(1000);
    expect(results.numeric).toBeLessThan(1000);
  });
});
