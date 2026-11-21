import { describe, expect, it } from "vitest";

import { assignIds, existingIds } from "@/lib/style/ids";
import { apply, changedPaths, diff, merge } from "@/lib/style/merge";
import { parsePointer, toPointer } from "@/lib/style/pointer";

import { mergeCases } from "./fixtures";

describe.each(mergeCases())("merge case: $name", (c) => {
  it("merges like goatlib", () => {
    const { doc, refused } = merge(c.base, c.incoming, c.current);
    expect(doc).toEqual(c.expected);
    expect(changedPaths(refused)).toEqual(c.refused);
  });

  it("finds no diff between a document and itself", () => {
    expect(diff(c.incoming, c.incoming)).toEqual([]);
  });
});

describe("ids and pointers", () => {
  it("assigns ids like goatlib", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = assignIds<any>({
      classify: [{ field: "density", classes: [{}, {}] }, { field: "density" }],
      rules: [{}],
      popup: { blocks: [{ type: "divider" }] },
    });
    expect(out.classify.map((c: { id: string }) => c.id)).toEqual(["density", "k1"]);
    expect(out.classify[0].classes.map((k: { id: string }) => k.id)).toEqual(["c1", "c2"]);
    expect(out.rules[0].id).toBe("r1");
    expect(out.popup.blocks[0].id).toBe("b1");
  });

  it("keeps existing ids and avoids reserved ones", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = assignIds<any>({ classify: [{ id: "k1", field: "x", classes: [{ id: "c1" }, {}] }] }, ["c2"]);
    expect(out.classify[0].classes.map((k: { id: string }) => k.id)).toEqual(["c1", "c3"]);
    expect([...existingIds(out)].sort()).toEqual(["c1", "c3", "k1"]);
  });

  it("escapes pointer segments", () => {
    expect(toPointer(["a/b", "c~d"])).toBe("/a~1b/c~0d");
    expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
  });

  it("applies a change whose target is gone as refused", () => {
    const { refused } = apply({ classify: [] }, [
      { op: "set", path: ["classify", "x", "title"], value: "T" },
    ]);
    expect(changedPaths(refused)).toEqual(["/classify/x/title"]);
  });
});
