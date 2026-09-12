import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => {
  // Stable `t` reference (real react-i18next keeps `t` stable across renders);
  // a fresh `t` each call would churn the component's memoized callbacks.
  const t = (k: string) => k;
  return { useTranslation: () => ({ t }) };
});

const fakeMap = {
  getStyle: () => ({ sources: { osm: { attribution: "© MapTiler © OpenStreetMap contributors" } } }),
  on: vi.fn(),
  off: vi.fn(),
};
// What `useMap()` returns, per test: the project map is registered under the id
// `map` by `MapProvider`, while `current` is whichever map the control is mounted
// inside — all a surface without the provider has (the catalog's preview maps).
let mapContext: Record<string, unknown> = { map: fakeMap };
vi.mock("react-map-gl/maplibre", () => ({
  useMap: () => mapContext,
}));

import AttributionControl from "../Attribution";

// Force overflow: capture the ResizeObserver callback and make scrollWidth > clientWidth.
let roCallback: (() => void) | null = null;
beforeEach(() => {
  roCallback = null;
  mapContext = { map: fakeMap };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        roCallback = cb;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

describe("AttributionControl", () => {
  it("renders the localized GOAT credit and 'Data from' with the source credit, without MapLibre", () => {
    render(<AttributionControl />);
    // `t` is mocked to echo the key, so the branding label renders as its key.
    expect(screen.getByText(/made_with_goat/)).toBeInTheDocument();
    expect(screen.getByText(/data_from/)).toBeInTheDocument();
    expect(screen.getByText(/OpenStreetMap contributors/)).toBeInTheDocument();
    expect(screen.queryByText(/MapLibre/i)).not.toBeInTheDocument();
  });

  it("falls back to the map it is mounted inside when no project map is registered", () => {
    // The catalog's preview maps mount a map without `MapProvider`, so nothing is
    // registered under the id `map`. Reading only that key left the control with no
    // sources — it still rendered, but silently dropped the tile and data credits
    // it exists to show, which are the two that are actually required.
    mapContext = { current: fakeMap };
    render(<AttributionControl />);
    expect(screen.getByText(/OpenStreetMap contributors/)).toBeInTheDocument();
    expect(screen.getByText(/MapTiler/)).toBeInTheDocument();
  });

  it("prefers the map it is mounted inside over the registered project map", () => {
    // Both are defined while the Add Layer modal is open over a project map. The
    // strip must describe the map it lives in, not whichever one the provider
    // happens to have registered.
    const projectMap = {
      getStyle: () => ({ sources: { osm: { attribution: "© Project basemap" } } }),
      on: vi.fn(),
      off: vi.fn(),
    };
    mapContext = { map: projectMap, current: fakeMap };
    render(<AttributionControl />);
    expect(screen.getByText(/OpenStreetMap contributors/)).toBeInTheDocument();
    expect(screen.queryByText(/Project basemap/)).not.toBeInTheDocument();
  });

  it("credits a source whose attribution arrives with its TileJSON", () => {
    // A source declared with a `url` — every OpenFreeMap style, and BKG's world
    // style — has no attribution in the style document: MapLibre merges the
    // TileJSON's credit onto the live source and `getStyle()` serializes the
    // spec as written. Reading only the spec left an OSM-derived basemap
    // rendering with no attribution at all, which the ODbL requires.
    const tileJsonMap = {
      getStyle: () => ({ sources: { openmaptiles: { type: "vector", url: "https://tiles.example/planet" } } }),
      getSource: (id: string) =>
        id === "openmaptiles"
          ? { attribution: "<a href='https://openfreemap.org'>OpenFreeMap</a> © OpenMapTiles Data from OpenStreetMap" }
          : undefined,
      on: vi.fn(),
      off: vi.fn(),
    };
    mapContext = { map: tileJsonMap };
    render(<AttributionControl />);
    expect(screen.getByText(/OpenFreeMap/)).toBeInTheDocument();
    expect(screen.getByText(/OpenStreetMap/)).toBeInTheDocument();
  });

  it("shows a 'more' link on overflow that opens the attributions modal", () => {
    const { container } = render(<AttributionControl />);
    const textEl = container.querySelector("[data-testid='attribution-text']") as HTMLElement;
    Object.defineProperty(textEl, "scrollWidth", { configurable: true, value: 500 });
    Object.defineProperty(textEl, "clientWidth", { configurable: true, value: 100 });
    act(() => {
      roCallback?.();
    });

    const moreLink = screen.getByText("show_more");
    expect(moreLink).toBeInTheDocument();
    fireEvent.click(moreLink);

    // Dialog open: title + credit listed
    expect(screen.getByText("attributions")).toBeInTheDocument();
    expect(screen.getAllByText(/OpenStreetMap contributors/).length).toBeGreaterThan(0);
  });
});
