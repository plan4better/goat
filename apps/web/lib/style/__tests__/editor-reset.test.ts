import { describe, expect, it } from "vitest";

import { resetParts } from "@/lib/style/editor/reset";
import type { LayerStyle } from "@/lib/style/generated/types";
import { sameAsWritten } from "@/lib/style/json";

/** resetParts, its classifications readable (a vector style's). */
const reset = (...args: Parameters<typeof resetParts>) =>
  resetParts(...args) as LayerStyle & { classify?: unknown[] };

const doc = (extra: object) => ({ version: 1, kind: "vector", ...extra }) as LayerStyle;

const FILL_BY_USE = {
  id: "use",
  field: "use",
  method: "categories",
  classes: [{ values: ["a"], fill: { color: "#111111" } }],
  computed: { values: ["a"] },
};
const LABEL_SIZE_BY_LEVEL = {
  id: "level",
  field: "level",
  method: "quantile",
  target: "label.size",
  classes: [{ label: { size: 10 } }, { label: { size: 14 } }],
};

describe("resetParts", () => {
  it("puts the reference's part back and removes a part the reference has not", () => {
    const current = doc({ symbol: { fill: { color: "#d7301f" }, label: { text: "{{use}}" } } });
    const reference = doc({ symbol: { fill: { color: "#2bb381" } } });
    expect(reset(current, reference, ["symbol.fill"], "polygon")).toEqual(
      doc({ symbol: { fill: { color: "#2bb381" }, label: { text: "{{use}}" } } })
    );
    expect(reset(current, reference, ["symbol.label"], "polygon")).toEqual(
      doc({ symbol: { fill: { color: "#d7301f" } } })
    );
  });

  it("replaces the part's classifications with the reference's, where the first one was", () => {
    const current = doc({
      symbol: { fill: {}, label: { text: "{{use}}" } },
      classify: [LABEL_SIZE_BY_LEVEL, FILL_BY_USE],
    });
    const reference = doc({ symbol: { fill: { color: "#2bb381" }, label: { text: "{{use}}" } } });
    const fillReset = reset(current, reference, ["symbol.fill"], "polygon");
    expect(fillReset.classify).toEqual([LABEL_SIZE_BY_LEVEL]);
    // The label as the reference has it: unclassed.
    const labelReset = reset(current, reference, ["symbol.label"], "polygon");
    expect(labelReset.classify).toEqual([FILL_BY_USE]);
    // A reference that classes the label brings its classification back, in the place of the one it replaces.
    const classed = doc({
      ...reference,
      classify: [{ ...LABEL_SIZE_BY_LEVEL, classes: [{ label: { size: 9 } }] }],
    });
    expect(reset(current, classed, ["symbol.label"], "polygon").classify).toEqual([
      { ...LABEL_SIZE_BY_LEVEL, classes: [{ label: { size: 9 } }] },
      FILL_BY_USE,
    ]);
  });

  it("takes the part out of other classifications' classes (a class's own value of it)", () => {
    const withOutline = {
      ...FILL_BY_USE,
      classes: [{ values: ["a"], fill: { color: "#111111" }, outline: { width: 3 } }],
    };
    const current = doc({ symbol: { fill: {}, outline: { width: 1 } }, classify: [withOutline] });
    const reference = doc({ symbol: { fill: {}, outline: { width: 1 } } });
    expect(reset(current, reference, ["symbol.outline"], "polygon").classify).toEqual([FILL_BY_USE]);
  });

  it("gives a classification it brings back a free id", () => {
    const current = doc({ symbol: { fill: {}, label: {} }, classify: [{ ...FILL_BY_USE, id: "level" }] });
    const reference = doc({ symbol: { fill: {}, label: {} }, classify: [LABEL_SIZE_BY_LEVEL] });
    const next = reset(current, reference, ["symbol.label"], "polygon");
    const ids = (next.classify as { id: string }[]).map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("leaves a style that is already the reference's as it is, what the server computed aside", () => {
    const current = doc({ symbol: { fill: {} }, classify: [FILL_BY_USE] });
    const reference = doc({
      symbol: { fill: {} },
      classify: [{ ...FILL_BY_USE, computed: { values: ["b"] } }],
    });
    expect(sameAsWritten(reset(current, reference, ["symbol.fill"], "polygon"), current)).toBe(true);
  });
});
