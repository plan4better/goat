import { fireEvent, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import { LayerTimeSlider } from "@/components/map/panels/layer/LayerTimeSlider";

const { uniqueValues } = vi.hoisted(() => ({
  uniqueValues: vi.fn(async () => ({
    items: ["2024", "2010", "2016"].map((value) => ({ value, count: 1 })),
    total: 3,
  })),
}));
vi.mock("@/lib/api/layers", () => ({ getLayerUniqueValues: uniqueValues }));

function renderSlider(value?: number) {
  const onChange = vi.fn();
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <LayerTimeSlider datasetId="d3" time={{ field: "year", step: 1 }} value={value} onChange={onChange} />
    </SWRConfig>
  );
  return onChange;
}

describe("the layer tree's time slider", () => {
  it("starts at the latest value and moves over the field's values", async () => {
    const onChange = renderSlider();
    expect(await screen.findByText("2024")).toBeInTheDocument();
    expect(uniqueValues).toHaveBeenCalledWith("d3", "year", 1000);
    // jsdom has no keyboard behavior for range inputs: move the thumb by changing its value (the step index).
    fireEvent.change(screen.getByRole("slider"), { target: { value: 1 } });
    expect(onChange).toHaveBeenCalledWith(2016, false);
    expect(onChange).toHaveBeenLastCalledWith(2016, true);
  });

  it("shows the stored value", async () => {
    renderSlider(2010);
    expect(await screen.findByText("2010")).toBeInTheDocument();
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("2010");
  });
});
