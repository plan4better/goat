import { describe, expect, it } from "vitest";

import {
  lockSnapshot,
  mapElementLayers,
  materializeMapElements,
  visibleProjectLayers,
} from "@/lib/print/mapElements";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { ReportElement } from "@/lib/validations/reportLayout";

import type { MapLayer } from "@/hooks/map/useMapLayers";

const initialView = {
  latitude: 52.5,
  longitude: 13.4,
  zoom: 11,
  bearing: 0,
  pitch: 0,
  min_zoom: 0,
  max_zoom: 20,
};

const doc = (color: string) => ({ version: 1, kind: "vector", symbol: { fill: { color } } }) as LayerStyle;

const layer = (id: number, visible = true): MapLayer =>
  ({
    id,
    visible,
    entry: { type: "layer", id, visible },
    style: {
      id: `s${id}`,
      name: "Default",
      position: 0,
      revision: 1,
      document: doc(`#${id}${id}${id}`),
      issues: [],
      stale: false,
    },
    otherStyles: [],
  }) as unknown as MapLayer;

const mapElement = (config: Record<string, unknown>): ReportElement => ({
  id: "map-1",
  type: "map",
  position: { x: 0, y: 0, width: 100, height: 80, z_index: 1 },
  config,
  style: { opacity: 1, padding: 0 },
});

const projectLayers = [layer(7), layer(8, false), layer(9)];
const ctx = { initialView, projectLayers, basemapUrl: "https://tiles.example/streets.json" };

describe("materializeMapElements", () => {
  it("gives a map element with no view the project's initial view", () => {
    const [el] = materializeMapElements([mapElement({})], ctx);
    expect(el.config.viewState).toEqual({ latitude: 52.5, longitude: 13.4, zoom: 11, bearing: 0, pitch: 0 });
  });

  it("leaves a saved view alone", () => {
    const saved = { latitude: 1, longitude: 2, zoom: 3, bearing: 0, pitch: 0 };
    const [el] = materializeMapElements([mapElement({ viewState: saved })], ctx);
    expect(el.config.viewState).toBe(saved);
  });

  it("captures the lock snapshot from the project's visible layers when a locked map has none", () => {
    const [el] = materializeMapElements([mapElement({ lock_layers: true, lock_styles: true })], ctx);
    expect(el.config.locked_layer_ids).toEqual([7, 9]);
    expect(el.config.locked_basemap_url).toBe(ctx.basemapUrl);
    expect(el.config.locked_layer_styles).toEqual({ 7: doc("#777"), 9: doc("#999") });
  });

  it("does not freeze styles when only layers are locked", () => {
    const [el] = materializeMapElements([mapElement({ lock_layers: true })], ctx);
    expect(el.config.locked_layer_ids).toEqual([7, 9]);
    expect(el.config.locked_layer_styles).toBeUndefined();
  });

  it("recaptures a snapshot whose ids belong to another project", () => {
    const [el] = materializeMapElements(
      [mapElement({ lock_layers: true, locked_layer_ids: [301, 302], locked_basemap_url: "old" })],
      ctx
    );
    expect(el.config.locked_layer_ids).toEqual([7, 9]);
    expect(el.config.locked_basemap_url).toBe(ctx.basemapUrl);
  });

  it("keeps a snapshot that still points at this project's layers", () => {
    const input = mapElement({
      lock_layers: true,
      locked_layer_ids: [9, 301],
      viewState: { latitude: 1, longitude: 2, zoom: 3 },
    });
    const result = materializeMapElements([input], ctx);
    expect(result[0]).toBe(input);
  });

  it("waits for the project's layers before capturing", () => {
    const elements = [mapElement({ lock_layers: true, viewState: { latitude: 1, longitude: 2, zoom: 3 } })];
    expect(materializeMapElements(elements, { ...ctx, projectLayers: [] })).toBe(elements);
  });

  it("returns the same array when nothing needs to change", () => {
    const elements = [
      mapElement({ viewState: { latitude: 1, longitude: 2, zoom: 3 } }),
      { ...mapElement({}), id: "text-1", type: "text" as const },
    ];
    expect(materializeMapElements(elements, ctx)).toBe(elements);
  });

  it("waits for the initial view before filling one in", () => {
    const elements = [mapElement({})];
    expect(materializeMapElements(elements, { ...ctx, initialView: undefined })).toBe(elements);
  });
});

describe("mapElementLayers", () => {
  it("locked maps keep their frozen documents", () => {
    const config = lockSnapshot(
      { lock_layers: true, lock_styles: true },
      visibleProjectLayers(projectLayers),
      "url"
    );
    // The project's style changes after the map was locked.
    const RED = doc("#ff0000");
    const changed = projectLayers.map((l) =>
      l.id === 7
        ? ({ ...l, visible: false, style: { ...l.style, revision: 2, document: RED } } as MapLayer)
        : l
    );
    const drawn = mapElementLayers(changed, config);
    expect(drawn.map((l) => l.id)).toEqual([7, 9]);
    expect(drawn[0].style?.document).toEqual(doc("#777"));
    // Locked layers show whatever the project's visibility is now.
    expect(drawn[0].visible).toBe(true);
    // A snapshot taken before GOAT Style (layer properties) draws the live style.
    const old = mapElementLayers(changed, { ...config, locked_layer_styles: { 7: { color: "#777" } } });
    expect(old[0].style?.document).toEqual(RED);
    // Unlocked: the project's drawn layers with their live styles; an atlas page can hide its coverage layer.
    expect(mapElementLayers(changed, {}).map((l) => l.id)).toEqual([9]);
    expect(mapElementLayers(projectLayers, {}, { hide: 9 }).map((l) => l.id)).toEqual([7]);
  });
});
