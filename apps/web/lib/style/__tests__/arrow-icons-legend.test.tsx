// The legend of a line whose arrows are an icon of the user's choice (spec 3.2 `arrows.icon`, 7.2): the line swatch
// shows the icon on the line, as the map draws it; GOAT's own arrow leaves the swatch a plain line.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type LegendSection, baseSwatch, buildLegend } from "@/lib/style/legend";

import { SwatchIcon } from "@/components/map/legend/StyleLegend";

const doc = (style: object) => ({ version: 1, kind: "vector", ...style });
const lineSwatch = (symbol: object) => baseSwatch(doc({ symbol }), { geometry: "line", zoom: 12 });
const entries = (section: LegendSection | undefined) => (section?.kind === "entries" ? section.entries : []);

describe("legend of icons along a line", () => {
  it("the line swatch carries the icon in the line's color", () => {
    const swatch = lineSwatch({
      line: { color: "#4d4d4d" },
      arrows: { icon: "goat:rail-light", placement: "repeat" },
    });
    expect(swatch.arrows).toEqual({
      icon: "goat:rail-light",
      color: "#4d4d4d",
      direction: "forward",
      placement: "repeat",
      turn_with_line: true,
    });
  });

  it("the arrows' own color and direction", () => {
    const swatch = lineSwatch({
      line: { color: "#4d4d4d" },
      arrows: { icon: "goat:circle-solid", color: "#d7301f", direction: "backward", placement: "end" },
    });
    expect(swatch.arrows).toMatchObject({ color: "#d7301f", direction: "backward", placement: "end" });
  });

  it("GOAT's arrow, and arrows switched off, leave a plain line", () => {
    expect(lineSwatch({ line: {}, arrows: { size: 12 } }).arrows).toBeUndefined();
    expect(lineSwatch({ line: {}, arrows: { icon: "goat:arrow" } }).arrows).toBeUndefined();
    expect(lineSwatch({ line: {}, arrows: false }).arrows).toBeUndefined();
    expect(lineSwatch({ line: {} }).arrows).toBeUndefined();
  });

  it("a class shows its own arrows' color, and none where it switches them off", () => {
    const legend = buildLegend(
      doc({
        symbol: { line: { color: "#999999" }, arrows: { icon: "goat:rail-light" } },
        classify: [
          {
            field: "status",
            method: "categories",
            classes: [
              { values: ["existing"], name: "Existing", line: { color: "#1b9e77" } },
              { values: ["planned"], name: "Planned", arrows: { color: "#d95f02" } },
              { values: ["closed"], name: "Closed", arrows: false },
            ],
          },
        ],
      }) as never,
      { geometry: "line", zoom: 12 }
    )!;
    const [existing, planned, closed] = entries(legend.sections[0]);
    expect(existing.swatch.arrows?.color).toBe("#1b9e77");
    expect(planned.swatch.arrows?.color).toBe("#d95f02");
    expect(closed.swatch.arrows).toBeUndefined();
  });

  it("draws a library icon tinted, turned along the line; an upload as it is", () => {
    const tinted = render(
      <SwatchIcon
        swatch={{
          geometry: "line",
          line: { color: "#4d4d4d" },
          arrows: { icon: "goat:rail-light", color: "#d7301f", direction: "forward", placement: "repeat" },
        }}
      />
    );
    const icon = tinted.container.querySelector<HTMLElement>("[data-marker-icon]")!;
    expect(icon.style.backgroundColor).toBe("rgb(215, 48, 31)");
    expect(tinted.container.querySelector<HTMLElement>("[data-arrow-icon]")!.style.transform).toBe(
      "rotate(90deg)"
    );
    const upload = render(
      <SwatchIcon
        swatch={{
          geometry: "line",
          line: { color: "#4d4d4d" },
          arrows: { icon: "emoji:1f525", color: "#d7301f", direction: "backward", placement: "center" },
        }}
      />
    );
    expect(upload.container.querySelector("img")?.getAttribute("src")).toMatch(/emoji\/1f525\.webp$/);
    expect(upload.container.querySelector<HTMLElement>("[data-arrow-icon]")!.style.transform).toBe(
      "rotate(-90deg)"
    );
  });

  it("draws an icon that stays upright unturned, once whatever the direction", () => {
    const swatch = lineSwatch({
      line: { color: "#4d4d4d" },
      arrows: { icon: "goat:park", direction: "both", turn_with_line: false },
    });
    expect(swatch.arrows).toMatchObject({ turn_with_line: false });
    const upright = render(<SwatchIcon swatch={swatch} />);
    const icons = upright.container.querySelectorAll<HTMLElement>("[data-arrow-icon]");
    expect(icons).toHaveLength(1);
    expect(icons[0].style.transform).toBe("rotate(0deg)");
  });
});
