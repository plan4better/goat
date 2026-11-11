// The thumbnail page in 3D (3D spec 10): a project's 3D view is captured only once its scene is on the map.
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ThumbnailPage from "@/app/thumbnail/[type]/[id]/page";

const { recorded } = vi.hoisted(() => ({
  recorded: {
    map: {} as Record<string, unknown>,
    scene: {} as Record<string, unknown>,
    compiled: null as object | null,
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ type: "project", id: "p1" }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("react-map-gl/maplibre", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Map: (props: Record<string, unknown>) => {
    recorded.map = props;
    return null;
  },
}));
vi.mock("@/hooks/map/useScene", () => ({
  useScene: (_map: unknown, inputs: Record<string, unknown>) => {
    recorded.scene = inputs;
    return recorded.compiled;
  },
}));

const VIEW = { latitude: 47.49, longitude: 11.09, zoom: 13, bearing: 30, pitch: 60 };
const inject = (data: unknown) => {
  (window as { __THUMBNAIL_DATA__?: string }).__THUMBNAIL_DATA__ = btoa(JSON.stringify(data));
};

beforeEach(() => {
  vi.useFakeTimers();
  recorded.map = {};
  recorded.scene = {};
  recorded.compiled = null;
  document.body.removeAttribute("data-thumbnail-ready");
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as { __THUMBNAIL_DATA__?: string }).__THUMBNAIL_DATA__;
});

const ready = () => document.body.getAttribute("data-thumbnail-ready");

describe("ThumbnailPage in 3D", () => {
  it("draws a project's 3D view with its scene and signals ready only once the scene is on", () => {
    inject({
      viewState: { ...VIEW, mode: "3d" },
      basemap: "light",
      layers: [],
      scene: { terrain: { exaggeration: 2 } },
    });
    const { rerender } = render(<ThumbnailPage />);
    expect(recorded.map).toMatchObject({
      maxPitch: 85,
      initialViewState: expect.objectContaining({ pitch: 60 }),
    });
    expect(recorded.scene).toMatchObject({
      mode: "3d",
      tone: "light",
      scene: { terrain: { exaggeration: 2 } },
    });

    act(() => (recorded.map.onLoad as () => void)());
    act(() => vi.advanceTimersByTime(5000));
    expect(ready()).toBeNull();

    recorded.compiled = {};
    rerender(<ThumbnailPage />);
    act(() => vi.advanceTimersByTime(5000));
    expect(ready()).toBe("true");
  });

  it("a flat project is ready after load, as before", () => {
    inject({ viewState: { ...VIEW, pitch: 0, bearing: 0 }, basemap: "light", layers: [] });
    render(<ThumbnailPage />);
    expect(recorded.map).toMatchObject({ maxPitch: 0 });
    act(() => (recorded.map.onLoad as () => void)());
    act(() => vi.advanceTimersByTime(5000));
    expect(ready()).toBe("true");
  });
});
