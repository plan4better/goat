// The icons of the "Draw as" choices: clusters have their own icon, not a workflow tool's, and the field and its menu
// draw every icon as the app's menus do (the rows' size, muted, the selected one in the check's ink, beside the
// label's first line).
import { createTheme } from "@mui/material";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { readableText } from "@/lib/utils/credits";

import { POPOVER_ROW_ICON_SIZE } from "@/components/common/popoverRow";
import { drawAsIcon } from "@/components/map/panels/styleEditor/drawAsIcons";
import { ChoiceRow } from "@/components/map/panels/styleEditor/rows";

import { renderPanel } from "./renderPanel";

const theme = createTheme();

describe("drawAsIcon", () => {
  it("draws clusters with the cluster icon, not the aggregate tool's", () => {
    expect(drawAsIcon("cluster")).toBe(ICON_NAME.CLUSTER);
  });

  it("has an icon for every point and raster choice", () => {
    for (const value of [
      "features",
      "heatmap",
      "cluster",
      "h3",
      "image",
      "continuous",
      "categorical",
      "hillshade",
    ]) {
      expect(drawAsIcon(value), value).toBeTruthy();
    }
    expect(drawAsIcon("unknown")).toBeUndefined();
  });
});

describe("the Draw as field and menu", () => {
  const renderChoice = (values: string[], value: string) =>
    renderPanel(
      <ChoiceRow
        label="Draw as"
        value={value}
        options={values.map((v) => ({ value: v, label: v, sub: `${v} sub`, icon: drawAsIcon(v) }))}
        onChange={() => undefined}
      />
    );

  it("draws the field's icon and each option's at the menu rows' icon size, muted, the selected one in ink", async () => {
    renderChoice(["features", "heatmap", "cluster", "h3"], "features");
    const field = screen.getByRole("combobox", { name: "Draw as" });
    expect(field.querySelector("svg")).toHaveStyle({
      fontSize: `${POPOVER_ROW_ICON_SIZE}px`,
      color: theme.palette.text.secondary,
    });

    await userEvent.click(field);
    const menu = screen.getByRole("listbox");
    const iconOf = (name: string) =>
      within(menu)
        .getByRole("option", { name: new RegExp(`^${name}`) })
        .querySelector("svg");
    // Beside the label's first line, not the middle of the two lines.
    expect(iconOf("features")).toHaveStyle({
      fontSize: `${POPOVER_ROW_ICON_SIZE}px`,
      color: readableText(theme, theme.palette.primary.main),
      marginTop: "3px",
    });
    for (const name of ["heatmap", "cluster", "h3"]) {
      expect(iconOf(name)).toHaveStyle({
        fontSize: `${POPOVER_ROW_ICON_SIZE}px`,
        color: theme.palette.text.secondary,
      });
    }
  });

  it("draws the raster choices' icons the same way", async () => {
    renderChoice(["image", "continuous", "categorical", "hillshade"], "continuous");
    const field = screen.getByRole("combobox", { name: "Draw as" });
    expect(field.querySelector("svg")).toHaveStyle({ fontSize: `${POPOVER_ROW_ICON_SIZE}px` });
    await userEvent.click(field);
    const icons = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((option) => option.querySelector("svg"));
    expect(icons).toHaveLength(4);
    for (const icon of icons) expect(icon).toHaveStyle({ fontSize: `${POPOVER_ROW_ICON_SIZE}px` });
  });
});
