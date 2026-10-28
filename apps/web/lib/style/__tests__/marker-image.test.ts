import { afterEach, describe, expect, it, vi } from "vitest";

import { parseMarkerImage } from "@/lib/style/compile/markerImage";
import { drawMarker, markerLayout } from "@/lib/style/render/markerImages";

/** A 2D context that records what is painted: each fill and stroke with its color and compositing. */
function recordingCanvas() {
  const painted: Array<{ op: "fill" | "stroke"; color: string; composite: string }> = [];
  const context = {
    globalCompositeOperation: "source-over",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineJoin: "miter",
    scale: vi.fn(),
    translate: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    roundRect: vi.fn(),
    fill() {
      painted.push({ op: "fill", color: this.fillStyle, composite: this.globalCompositeOperation });
    },
    stroke() {
      painted.push({ op: "stroke", color: this.strokeStyle, composite: this.globalCompositeOperation });
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = create(tag);
    if (tag === "canvas") (el as HTMLCanvasElement).getContext = (() => context) as never;
    return el;
  });
  vi.stubGlobal("Path2D", class {});
  return painted;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("marker images", () => {
  it("a name carries the shape, size, icon, colors and stroke", () => {
    expect(
      parseMarkerImage("goat-marker:square|24|emoji:1f525|rgba(214,39,40,1)|#ffffff|1.5|#ffffff")
    ).toEqual({
      shape: "square",
      size: 24,
      icon: "emoji:1f525",
      fill: "rgba(214,39,40,1)",
      stroke: "#ffffff",
      strokeWidth: 1.5,
      iconColor: "#ffffff",
    });
    expect(parseMarkerImage("goat-marker:circle|8||#2bb381||0|#ffffff")?.icon).toBe("");
  });

  it("other images and broken names are not markers", () => {
    expect(parseMarkerImage("goat:park")).toBeNull();
    expect(parseMarkerImage("goat-marker:triangle|8||#2bb381||0|#ffffff")).toBeNull();
    expect(parseMarkerImage("goat-marker:circle|0||#2bb381||0|#ffffff")).toBeNull();
    expect(parseMarkerImage("goat-marker:circle|8|#2bb381")).toBeNull();
  });

  it("the stroke lies outside the shape and the icon takes 60% of it", () => {
    const spec = parseMarkerImage("goat-marker:circle|20|goat:park|#f28e2b|#000000|2|#ffffff");
    expect(spec && markerLayout(spec)).toEqual({
      side: 24,
      shape: 20,
      offset: 2,
      icon: 12,
      iconX: 6,
      iconY: 6,
    });
    // A width without a stroke color draws nothing.
    const bare = parseMarkerImage("goat-marker:circle|20||#f28e2b||2|#ffffff");
    expect(bare && markerLayout(bare)).toEqual({
      side: 20,
      shape: 20,
      offset: 0,
      icon: 0,
      iconX: 10,
      iconY: 10,
    });
  });

  it("every shape and pin is a marker; a pin's icon sits in its head", () => {
    for (const shape of [
      "diamond",
      "hexagon",
      "shield",
      "pin",
      "round_pin",
      "needle",
      "square_pin",
      "tag_pin",
      "flag",
    ])
      expect(parseMarkerImage(`goat-marker:${shape}|24||#2bb381||0|#ffffff`)?.shape).toBe(shape);
    const pin = parseMarkerImage("goat-marker:pin|24|goat:park|#2bb381||0|#ffffff");
    // The head's centre is (12, 9) of the 24 box and the icon half the marker's size.
    expect(pin && markerLayout(pin)).toEqual({
      side: 24,
      shape: 24,
      offset: 0,
      icon: 12,
      iconX: 6,
      iconY: 3,
    });
  });

  it("a filled marker paints its stroke, then its fill over the stroke's inner half", async () => {
    const painted = recordingCanvas();
    await drawMarker("goat-marker:diamond|20||#1a6b4d|#ffffff|2|#ffffff");
    expect(painted).toEqual([
      { op: "stroke", color: "#ffffff", composite: "source-over" },
      { op: "fill", color: "#1a6b4d", composite: "source-over" },
    ]);
  });

  it("a hollow marker (no fill in its name) keeps the stroke outside the shape and clears the inside", async () => {
    expect(parseMarkerImage("goat-marker:circle|20|||#1a6b4d|2|#1a6b4d")?.fill).toBe("");
    for (const shape of ["circle", "pin"]) {
      const painted = recordingCanvas();
      await drawMarker(`goat-marker:${shape}|20|||#1a6b4d|2|#1a6b4d`);
      expect(painted).toEqual([
        { op: "stroke", color: "#1a6b4d", composite: "source-over" },
        { op: "fill", color: "#000000", composite: "destination-out" },
      ]);
      vi.restoreAllMocks();
    }
    // Hollow without an outline: nothing of the shape is painted.
    const bare = recordingCanvas();
    await drawMarker("goat-marker:square|20|||||#ffffff");
    expect(bare).toEqual([]);
  });
});
