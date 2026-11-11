import { describe, expect, it } from "vitest";

import { isMeasureCardShown, rightStackInsets } from "../rightStack";

const closed = {
  measureCard: false,
  featureEdit: false,
  rightPanel: false,
  explorerActive: false,
  explorerRightRoom: 0,
};

describe("isMeasureCardShown", () => {
  it("is hidden while only the tool menu is open", () => {
    expect(isMeasureCardShown({ measureOpen: true, activeTool: undefined, measurementCount: 0 })).toBe(false);
  });

  it("shows once a tool is picked or a measurement exists", () => {
    expect(isMeasureCardShown({ measureOpen: true, activeTool: "line", measurementCount: 0 })).toBe(true);
    expect(isMeasureCardShown({ measureOpen: false, activeTool: undefined, measurementCount: 2 })).toBe(true);
  });

  it("is hidden when the tool is closed with nothing measured", () => {
    expect(isMeasureCardShown({ measureOpen: false, activeTool: undefined, measurementCount: 0 })).toBe(
      false
    );
  });
});

describe("rightStackInsets", () => {
  it("keeps everything at the map's edge with nothing open", () => {
    expect(rightStackInsets(closed)).toEqual({ panelsWidth: 0, controlsRight: 10, popupRight: 10 });
  });

  it("leaves the map controls in place for the measure card, which sits above them", () => {
    const insets = rightStackInsets({ ...closed, measureCard: true });
    expect(insets.controlsRight).toBe(10);
    expect(insets.panelsWidth).toBe(0);
    // Popups still keep clear of the card.
    expect(insets.popupRight).toBe(320 + 16 + 10);
  });

  it("moves the map controls left of a full-height panel by its width and the gap", () => {
    expect(rightStackInsets({ ...closed, rightPanel: true })).toEqual({
      panelsWidth: 300,
      controlsRight: 300 + 16 + 10,
      popupRight: 300 + 16 + 10,
    });
    expect(rightStackInsets({ ...closed, featureEdit: true }).controlsRight).toBe(320 + 16 + 10);
    expect(rightStackInsets({ ...closed, featureEdit: true, rightPanel: true })).toEqual({
      panelsWidth: 320 + 16 + 300,
      controlsRight: 320 + 16 + 300 + 16 + 10,
      popupRight: 320 + 16 + 300 + 16 + 10,
    });
  });

  it("counts the measure card for popups only when a full-height panel is open too", () => {
    expect(rightStackInsets({ ...closed, measureCard: true, rightPanel: true })).toEqual({
      panelsWidth: 300,
      controlsRight: 300 + 16 + 10,
      popupRight: 320 + 16 + 300 + 16 + 10,
    });
  });

  it("ignores the data view's panels in the Explorer and keeps clear of its right panel", () => {
    expect(
      rightStackInsets({
        ...closed,
        explorerActive: true,
        explorerRightRoom: 376,
        rightPanel: true,
        featureEdit: true,
      })
    ).toEqual({ panelsWidth: 0, controlsRight: 10 + 376, popupRight: 10 });
    expect(
      rightStackInsets({ ...closed, explorerActive: true, explorerRightRoom: 376, measureCard: true })
        .controlsRight
    ).toBe(10 + 376);
  });
});
