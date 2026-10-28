import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import { renderLayersOf } from "@/lib/style/render/viewLayers";
import { timeStepsOf } from "@/lib/style/time";

describe("time slider steps", () => {
  it("integer steps are the field's distinct values in order", () => {
    expect(timeStepsOf(["2024", "2010", "2016", "2010"], { field: "year", step: 1 })).toEqual([
      2010, 2016, 2024,
    ]);
    expect(timeStepsOf(["2024", "x"], { field: "year" })).toEqual([2024]);
  });

  it("date steps are the periods the dates fall in", () => {
    const dates = ["2024-03-15", "2024-03-01 10:00:00", "2023-12-31", "2024-01-02"];
    expect(timeStepsOf(dates, { field: "day", step: "month" })).toEqual(["2023-12", "2024-01", "2024-03"]);
    expect(timeStepsOf(dates, { field: "day", step: "year" })).toEqual(["2023", "2024"]);
    expect(timeStepsOf(dates, { field: "day", step: "day" })).toEqual([
      "2023-12-31",
      "2024-01-02",
      "2024-03-01",
      "2024-03-15",
    ]);
  });

  it("a layer without a slider value starts at the latest step", () => {
    const style = { version: 1, kind: "vector", time: { field: "year", step: 1 } } as LayerStyle;
    const layer = (time?: number) => ({
      id: 3,
      layer_id: "d3",
      type: "feature",
      feature_layer_geometry_type: "point",
      visible: true,
      entry: time === undefined ? {} : { time: { value: time } },
      style: { id: "s", revision: 1, document: style },
    });
    const [started] = renderLayersOf([layer()], { timeDefaults: { "3": 2024 } });
    expect(started.entry.time).toEqual({ value: 2024 });
    // A stored slider value wins.
    const [stored] = renderLayersOf([layer(2016)], { timeDefaults: { "3": 2024 } });
    expect(stored.entry.time).toEqual({ value: 2016 });
  });
});
