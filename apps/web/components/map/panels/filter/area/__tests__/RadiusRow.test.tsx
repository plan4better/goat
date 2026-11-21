/**
 * A circle's radius row: the slider and the number show the circle's radius as it is, also one off the slider's
 * steps (a circle drawn on the map), and the slider moves it to its steps.
 */
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RadiusRow } from "@/components/map/panels/filter/area/RadiusRow";

import { renderWithProviders } from "../../../styleEditor/__tests__/renderPanel";

const slider = () => screen.getByRole("slider", { name: "filter_panel.area_radius" }) as HTMLInputElement;
const field = () => screen.getByRole("textbox", { name: "filter_panel.area_radius" }) as HTMLInputElement;

describe("RadiusRow", () => {
  it("shows a drawn radius off the slider's steps on the slider as in the number", () => {
    renderWithProviders(<RadiusRow km={3.333} onChange={vi.fn()} />);
    expect(field().value).toBe("3.33");
    expect(slider().getAttribute("aria-valuenow")).toBe("3.333");
    // A browser rounds a range input's value to its step: the slider's input takes any value.
    expect(slider().getAttribute("step")).toBe("any");
  });

  it("moves a radius off the steps to the next step the way the slider went", () => {
    const onChange = vi.fn();
    renderWithProviders(<RadiusRow km={3.333} onChange={onChange} />);
    fireEvent.change(slider(), { target: { value: "3.4" } });
    expect(onChange).toHaveBeenLastCalledWith(3.5);
    fireEvent.change(slider(), { target: { value: "3.2" } });
    expect(onChange).toHaveBeenLastCalledWith(3);
  });

  it("moves a radius on a step by a whole step, however small the browser's", () => {
    const onChange = vi.fn();
    renderWithProviders(<RadiusRow km={3.5} onChange={onChange} />);
    fireEvent.change(slider(), { target: { value: "3.745" } });
    expect(onChange).toHaveBeenLastCalledWith(4);
    fireEvent.change(slider(), { target: { value: "3.255" } });
    expect(onChange).toHaveBeenLastCalledWith(3);
  });
});
