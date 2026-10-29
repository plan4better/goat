import { describe, expect, it } from "vitest";

import type { ContentItem } from "@/lib/validations/content";

import { canAppendTo } from "@/components/workflows/panels/WorkflowNodeSettings";

const item = (over: Partial<ContentItem> & Record<string, unknown>) =>
  ({
    type: "layer",
    id: "l1",
    name: "x",
    my_role: "viewer",
    layer_type: "feature",
    ...over,
  }) as unknown as ContentItem;

describe("canAppendTo", () => {
  // Edit rights are not judged from the list's role: the write-access check
  // (the rule the run uses) decides, and the panel warns after the pick.
  it("lets any feature layer or table be picked, whatever role the list shows", () => {
    expect(canAppendTo(item({ my_role: "viewer" }))).toBe(true);
    expect(canAppendTo(item({ my_role: "editor", layer_type: "table" }))).toBe(true);
  });

  it("rules out what rows can never go into", () => {
    expect(canAppendTo(item({ layer_type: "raster" }))).toBe(false);
    expect(canAppendTo(item({ type: "project" }))).toBe(false);
  });
});
