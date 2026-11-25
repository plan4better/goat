// The panel's fields read like the tool forms' fields under the app theme: a chosen value as the Selector's (body2,
// bold, the secondary text color), a number as TextFieldInput's (regular weight).
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ThemeProvider from "@p4b/ui/theme/ThemeProvider";

import {
  ChoiceRow,
  FormButton,
  NavRow,
  NumberInput,
  SliderRow,
} from "@/components/map/panels/styleEditor/rows";

import { renderPanel } from "./renderPanel";

const text = (el: Element) => {
  const style = getComputedStyle(el);
  return { color: style.color, weight: style.fontWeight, size: style.fontSize, lineHeight: style.lineHeight };
};

describe.each(["light", "dark"] as const)("field text in the %s theme", (mode) => {
  const inTheme = (ui: React.ReactElement) =>
    renderPanel(<ThemeProvider settings={{ mode, locale: "en" }}>{ui}</ThemeProvider>);

  it("a value that opens an editor reads like the Selector's chosen value", () => {
    inTheme(
      <>
        <ChoiceRow
          label="Draw as"
          value="points"
          options={[{ value: "points", label: "Points" }]}
          onChange={() => undefined}
        />
        <NavRow label="Visible" value="Zoom 1 to 23" onOpen={() => undefined} />
        <FormButton text="By zoom" onOpen={() => undefined} />
      </>
    );
    const selector = within(screen.getByRole("combobox")).getByText("Points");
    const reference = text(selector);
    expect(reference.weight).toBe("700");
    expect(text(screen.getByText("Zoom 1 to 23"))).toEqual(reference);
    expect(text(screen.getByText("By zoom"))).toEqual(reference);
  });

  it("a slider's number has the weight of the number fields", () => {
    inTheme(
      <>
        <SliderRow label="Size" min={0} max={60} step={1} value={4} unit="px" onChange={() => undefined} />
        <NumberInput value={21} ariaLabel="Width" onChange={() => undefined} />
      </>
    );
    const slider = screen.getByRole("textbox", { name: "Size" });
    const field = screen.getByRole("textbox", { name: "Width" });
    const weight = (input: HTMLElement) =>
      getComputedStyle(input.closest(".MuiInputBase-root") as HTMLElement).fontWeight;
    expect(weight(slider)).toBe(weight(field));
    // The hidden copy that sizes the number has its weight, so the number fits its room.
    const sizer = slider.closest("[data-reserve]")?.querySelector("[data-sizer]") as HTMLElement;
    expect(getComputedStyle(sizer).fontWeight).toBe(weight(slider));
  });
});
