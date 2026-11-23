import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { NumberFormatEditor } from "@/components/map/panels/styleEditor/editors/NumberFormatEditor";

import { renderPanel } from "./renderPanel";

describe("a number format's percent", () => {
  it("Percent writes the format as a percent of 1; off again removes it", async () => {
    const { store } = renderPanel(<NumberFormatEditor path="symbol.label.format" />, {
      document: { version: "1.0.0", kind: "vector", symbol: { label: { text: "{share}" } } } as LayerStyle,
    });
    const percent = () => screen.getByRole("checkbox", { name: "style_editor.percent" });
    await userEvent.click(percent());
    expect(store.get("symbol.label.format")).toEqual({ percent: true });
    await userEvent.click(percent());
    expect(store.get("symbol.label.format")).toBeUndefined();
  });
});
