import { describe, expect, it } from "vitest";

import type { FilterArea } from "@/lib/filter/area";
import type { FilterModel } from "@/lib/filter/model";

import { reduceDraft } from "@/components/map/panels/filter/draft";

const AREA: FilterArea = {
  pieces: [
    {
      kind: "view",
      polygons: [
        [
          [
            [7, 50],
            [8, 50],
            [8, 51],
            [7, 51],
            [7, 50],
          ],
        ],
      ],
    },
  ],
  op: "inside",
  enabled: true,
};
const ROW = { id: "r0", field: "name", op: "is" as const, value: "a", enabled: true };

describe("the draft's area", () => {
  it("sets the area and leaves the rows as they are", () => {
    const model: FilterModel = { match: "all", rows: [ROW] };
    const next = reduceDraft(model, { type: "area", area: AREA });
    expect(next.area).toBe(AREA);
    expect(next.rows).toBe(model.rows);
  });

  it("replaces the area", () => {
    const outside: FilterArea = { ...AREA, op: "outside" };
    const next = reduceDraft({ match: "all", rows: [], area: AREA }, { type: "area", area: outside });
    expect(next.area).toBe(outside);
  });

  it("removes the area with its key", () => {
    const next = reduceDraft({ match: "any", rows: [ROW], area: AREA }, { type: "area", area: undefined });
    expect(next).toEqual({ match: "any", rows: [ROW] });
    expect("area" in next).toBe(false);
  });

  it("gives the same model back when nothing changes", () => {
    const withArea: FilterModel = { match: "all", rows: [], area: AREA };
    expect(reduceDraft(withArea, { type: "area", area: AREA })).toBe(withArea);
    const without: FilterModel = { match: "all", rows: [] };
    expect(reduceDraft(without, { type: "area", area: undefined })).toBe(without);
  });

  it("clear removes the area with the rows", () => {
    expect(reduceDraft({ match: "all", rows: [ROW], area: AREA }, { type: "clear" })).toEqual({
      match: "all",
      rows: [],
    });
    expect(reduceDraft({ match: "all", rows: [], area: AREA }, { type: "clear" })).toEqual({
      match: "all",
      rows: [],
    });
    const empty: FilterModel = { match: "all", rows: [] };
    expect(reduceDraft(empty, { type: "clear" })).toBe(empty);
  });
});
