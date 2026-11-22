// Ids for the list items without one (goatlib `style/ids.py`): the same ids as goatlib, each number looked at once.
import { describe, expect, it } from "vitest";

import { assignIds, freshId, withRuleIds } from "@/lib/style/ids";

describe("ids", () => {
  it("takes the first free number after ids a document keeps, as goatlib", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = assignIds<any>({
      classify: [
        { id: "k1", field: "a", classes: [{ id: "c2" }, {}, { id: "c1" }, {}, { id: "c5" }, {}] },
        { field: "c4", classes: [{}] },
      ],
    });
    expect(out.classify[0].classes.map((k: { id: string }) => k.id)).toEqual([
      "c2",
      "c3",
      "c1",
      "c4",
      "c5",
      "c6",
    ]);
    // The field name is taken by then, so the classification counts on from k1.
    expect(out.classify[1].id).toBe("k2");
    expect(out.classify[1].classes[0].id).toBe("c7");
    expect(assignIds(out)).toEqual(out);
  });

  it("skips reserved ids", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = assignIds<any>({ rules: [{}, {}, {}] }, ["r1", "r3"]);
    expect(out.rules.map((r: { id: string }) => r.id)).toEqual(["r2", "r4", "r5"]);
  });

  it("gives out fresh ids with a counter looking at each number once", () => {
    let checks = 0;
    class CountingSet extends Set<string> {
      has(value: string) {
        checks += 1;
        return super.has(value);
      }
    }
    const taken = new CountingSet(["c1", "c3"]);
    const counters = new Map<string, number>();
    checks = 0;
    const ids = Array.from({ length: 20_000 }, () => freshId("c", taken, counters));
    expect(ids.slice(0, 3)).toEqual(["c2", "c4", "c5"]);
    expect(new Set(ids).size).toBe(20_000);
    // One check per number given out or skipped, not one per number below it.
    expect(checks).toBe(20_000 + 2);
  });

  it("gives 20,000 items without ids their ids quickly", () => {
    const doc = {
      classify: [{ field: "c", classes: Array.from({ length: 20_000 }, (_, i) => ({ values: [`v${i}`] })) }],
      rules: Array.from({ length: 5_000 }, () => ({})),
    };
    const start = performance.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = assignIds<any>(doc);
    // A bound for work that grows with the square of the input, not for the machine: CI runners are several times
    // slower than a laptop and share their cores.
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(out.classify[0].classes[0].id).toBe("c1");
    expect(out.classify[0].classes[19_999].id).toBe("c20000");
    expect(out.rules[4_999].id).toBe("r5000");
  });

  it("gives rules without an id the first free numbers, many quickly", () => {
    const few = withRuleIds({ rules: [{}, { id: "r2" }, {}] }) as { rules: Array<{ id: string }> };
    expect(few.rules.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    const start = performance.now();
    const many = withRuleIds({ rules: Array.from({ length: 20_000 }, () => ({})) }) as {
      rules: Array<{ id: string }>;
    };
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(many.rules[19_999].id).toBe("r20000");
  });
});
