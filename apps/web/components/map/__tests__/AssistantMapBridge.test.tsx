import { configureStore } from "@reduxjs/toolkit";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type MapResponse, type StyleRead, projectMapUrl, useProjectMap } from "@/lib/api/map";
import {
  PROJECTS_API_BASE_URL,
  projectLayerGroupsKey,
  projectLayersKey,
  useProject,
  useProjectLayerGroups,
  useProjectLayers,
} from "@/lib/api/projects";
import { fakeMap } from "@/lib/assistant/__tests__/fakeMap";
import { getMapBridge } from "@/lib/assistant/mapBridge";
import type { MapChange } from "@/lib/assistant/mapEdits";
import type { MapLike } from "@/lib/assistant/mapView";
import type { StyleChange } from "@/lib/assistant/styleEdits";
import { initView, mapReducer, setMapMode } from "@/lib/store/map/slice";
import { StyleStoresProvider, useStyleStores } from "@/lib/style/editor/StyleStores";
import type { StyleStoreRegistry } from "@/lib/style/editor/registry";
import type { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle, Scene } from "@/lib/style/generated/types";

import { SceneStoreProvider, useSceneStoreContext } from "@/hooks/map/useSceneStore";

import AssistantMapBridge from "@/components/map/AssistantMapBridge";

const { fetchMock, rowsMock, graphics } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  rowsMock: vi.fn(),
  graphics: { value: "hardware" },
}));
vi.mock("@/lib/api/fetcher", () => ({
  apiRequestAuth: fetchMock,
  fetcher: rowsMock,
  renewAccessToken: vi.fn(async () => true),
}));
vi.mock("@/lib/providers/PublicProjectProvider", () => ({ useIsPublicProject: () => false }));
vi.mock("@/lib/scene/support", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  graphicsSupport: () => graphics.value,
}));

const PROJECT = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";

const doc = (color: string) =>
  ({ version: "1.0.0", kind: "vector", symbol: { fill: { color } } }) as LayerStyle;
const style = (id: string, revision: number, color: string): StyleRead => ({
  id,
  name: id,
  position: 0,
  revision,
  document: doc(color),
  issues: [],
  stale: false,
});
const mapOf = (active: Record<string, StyleRead>): MapResponse => ({
  map: {
    version: "1.0.0",
    layers: Object.entries(active).map(([id, s]) => ({
      type: "layer" as const,
      id: Number(id),
      visible: true,
      style: s.id,
    })),
  },
  styles: Object.fromEntries(Object.entries(active).map(([id, s]) => [id, { active: s, others: [] }])),
  unpublished: [],
});
const change = (styleId: string, revision: number | null, extra: Partial<StyleChange> = {}): StyleChange => ({
  projectId: PROJECT,
  layerProjectId: 7,
  styleId,
  revision,
  listChanged: false,
  ...extra,
});

const answer = (status: number, json?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: () => Promise.resolve(json),
});

/** What core holds: the map request's answer and the styles by id. */
let server: { map: MapResponse | Promise<MapResponse>; styles: Record<string, StyleRead> };
/** The requests made, as "map", "style <layer>/<id>", "layers", "groups", "project" or "put scene". */
let requests: string[];
const styleReads = () => requests.filter((request) => request.startsWith("style"));
const mapReads = () => requests.filter((request) => request === "map");
/** The keys of the layer rows, the groups and the project row, by the name their requests are listed under. */
const ROWS: Record<string, string> = {
  [projectLayersKey(PROJECT)[0]]: "layers",
  [projectLayerGroupsKey(PROJECT)[0]]: "groups",
  [`${PROJECTS_API_BASE_URL}/${PROJECT}`]: "project",
};

let shown: MapResponse | undefined;
let registry: StyleStoreRegistry | null;
let sceneStore: EditorStore | null;
let redux: ReturnType<typeof newRedux>;
let mapRef: { current: (MapLike & ReturnType<typeof fakeMap>) | null };
const newRedux = () => configureStore({ reducer: { map: mapReducer } });
const shownScene = () => (sceneStore?.document as unknown as { scene: Scene } | undefined)?.scene;
function Page({ isEditor }: { isEditor: boolean }) {
  shown = useProjectMap(PROJECT).map;
  registry = useStyleStores();
  sceneStore = useSceneStoreContext();
  // The page's own readers of the rows: a key nobody reads is not asked again.
  useProjectLayers(PROJECT);
  useProjectLayerGroups(PROJECT);
  useProject(PROJECT);
  return <AssistantMapBridge projectId={PROJECT} isEditor={isEditor} mapRef={mapRef} />;
}

async function open(isEditor = true) {
  const view = render(
    <Provider store={redux}>
      <SWRConfig value={{ provider: () => new Map() }}>
        <SceneStoreProvider projectId={PROJECT} initial={{ buildings: true }} editable={isEditor}>
          <StyleStoresProvider>
            <Page isEditor={isEditor} />
          </StyleStoresProvider>
        </SceneStoreProvider>
      </SWRConfig>
    </Provider>
  );
  await waitFor(() => expect(shown).toBeDefined());
  await waitFor(() =>
    expect(requests.filter((request) => request in { layers: 1, groups: 1, project: 1 })).toHaveLength(3)
  );
  return view;
}
const follow = (changes: StyleChange[]) => getMapBridge(PROJECT)?.followStyles(changes);
const active = (layerProjectId = 7) => shown?.styles[String(layerProjectId)]?.active;
const mapChange = (flags: Partial<MapChange> = {}): MapChange => ({
  projectId: PROJECT,
  layers: false,
  state: false,
  groups: false,
  basemap: false,
  scene: false,
  ...flags,
});
const followMap = (flags: Partial<MapChange>) => getMapBridge(PROJECT)!.followMap(mapChange(flags));

beforeEach(() => {
  shown = undefined;
  registry = null;
  sceneStore = null;
  graphics.value = "hardware";
  redux = newRedux();
  redux.dispatch(initView({ projectId: PROJECT, mode: "2d", projection: "mercator" }));
  mapRef = { current: fakeMap({ lng: 11.5, lat: 48.1, zoom: 9 }) };
  requests = [];
  rowsMock.mockReset();
  rowsMock.mockImplementation(async ([url]: string[]) => {
    requests.push(ROWS[url] ?? url);
    return ROWS[url] === "project" ? { id: PROJECT } : [];
  });
  server = {
    map: mapOf({ "7": style("s1", 4, "#cccccc"), "8": style("s9", 2, "#000000") }),
    styles: { s1: style("s1", 5, "#ff0000"), s9: style("s9", 2, "#000000") },
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      requests.push("put scene");
      return answer(200, {});
    }
    if (url === projectMapUrl(PROJECT)) {
      requests.push("map");
      return answer(200, await server.map);
    }
    const read = /\/layer\/(\d+)\/style\/([^/?]+)\?check=true$/.exec(url);
    if (!read) return answer(404);
    requests.push(`style ${read[1]}/${read[2]}`);
    const stored = server.styles[read[2]];
    return stored ? answer(200, stored) : answer(404);
  });
});
afterEach(cleanup);

describe("AssistantMapBridge", () => {
  it("registers for its project while the map page is open", async () => {
    const view = await open();
    expect(getMapBridge(PROJECT)).toMatchObject({ projectId: PROJECT, isEditor: true });
    expect(getMapBridge(OTHER)).toBeNull();
    view.unmount();
    expect(getMapBridge()).toBeNull();
  });

  it("writes the read style into the map cache when it is the active one", async () => {
    await open();
    await follow([change("s1", 5)]);
    await waitFor(() => expect(active()?.revision).toBe(5));
    expect(active()?.document).toEqual(doc("#ff0000"));
    expect(styleReads()).toEqual(["style 7/s1"]);
    expect(mapReads()).toHaveLength(1);
  });

  it("leaves the drawn style alone when the changed style is not the active one and re-reads the list", async () => {
    await open();
    server.styles.s2 = style("s2", 1, "#00ff00");
    let answerMap: (map: MapResponse) => void = () => undefined;
    server.map = new Promise<MapResponse>((resolve) => {
      answerMap = resolve;
    });
    const followed = follow([change("s2", 1, { listChanged: true })]);
    await waitFor(() => expect(mapReads()).toHaveLength(2));
    expect(styleReads()).toEqual(["style 7/s2"]);
    expect(active()).toEqual(style("s1", 4, "#cccccc"));
    answerMap(mapOf({ "7": style("s2", 1, "#00ff00"), "8": style("s9", 2, "#000000") }));
    await followed;
    await waitFor(() => expect(active()?.id).toBe("s2"));
    expect(mapReads()).toHaveLength(2);
  });

  it("hands the read style to an open store and to no other", async () => {
    await open();
    const mine = registry!.acquire(
      { projectId: PROJECT, layerProjectId: 7, styleId: "s1" },
      { document: doc("#cccccc"), revision: 4 }
    );
    const other = registry!.acquire(
      { projectId: PROJECT, layerProjectId: 8, styleId: "s9" },
      { document: doc("#000000"), revision: 2 }
    );
    await follow([change("s1", 5)]);
    expect(mine.document).toEqual(doc("#ff0000"));
    expect(mine.saver.revision).toBe(5);
    expect(mine.canUndo).toBe(true);
    expect(other.document).toEqual(doc("#000000"));
    expect(other.saver.revision).toBe(2);
    expect(other.canUndo).toBe(false);
    mine.undo();
    expect(mine.document).toEqual(doc("#cccccc"));
    mine.saver.dispose();
  });

  it("a change of another project is ignored", async () => {
    await open();
    await follow([change("s1", 5, { projectId: OTHER, listChanged: true })]);
    expect(styleReads()).toEqual([]);
    expect(mapReads()).toHaveLength(1);
    expect(active()?.revision).toBe(4);
  });

  it("re-reads the map once for several list changes", async () => {
    await open();
    server.styles.s2 = style("s2", 1, "#00ff00");
    server.styles.s3 = style("s3", 1, "#0000ff");
    await follow([
      change("s2", 1, { listChanged: true }),
      change("s3", 1, { listChanged: true }),
      change("s4", null, { listChanged: true, removed: true }),
    ]);
    expect(mapReads()).toHaveLength(2);
    expect(styleReads()).toEqual(["style 7/s2", "style 7/s3"]);
  });

  it("does not read a style the cache already holds at that revision", async () => {
    await open();
    await follow([change("s1", 4), change("s1", 3)]);
    expect(styleReads()).toEqual([]);
    expect(mapReads()).toHaveLength(1);
  });

  it("reads a style once for several changes of it, and one without a revision always", async () => {
    await open();
    await follow([change("s1", 4), change("s1", 5), change("s9", null, { layerProjectId: 8 })]);
    expect(styleReads()).toEqual(["style 7/s1", "style 8/s9"]);
    expect(active()?.revision).toBe(5);
  });

  it("an open store decides alone: it is not read at its revision, and is read when the cache is ahead of it", async () => {
    server.map = mapOf({ "7": style("s1", 5, "#ff0000") });
    await open();
    const key = { projectId: PROJECT, layerProjectId: 7, styleId: "s1" };
    const store = registry!.acquire(key, { document: doc("#cccccc"), revision: 4 });
    await follow([change("s1", 4)]);
    expect(styleReads()).toEqual([]);
    await follow([change("s1", 5)]);
    expect(styleReads()).toEqual(["style 7/s1"]);
    expect(store.document).toEqual(doc("#ff0000"));
    expect(store.canUndo).toBe(true);
    registry!.release(key);
  });

  it("does not put an older read over a newer style in the cache", async () => {
    server.map = mapOf({ "7": style("s1", 6, "#00ff00") });
    await open();
    await follow([change("s1", null)]);
    expect(styleReads()).toEqual(["style 7/s1"]);
    expect(active()).toEqual(style("s1", 6, "#00ff00"));
  });

  it("follows one call after the other: an edit of a style just made active lands on the re-read map", async () => {
    await open();
    server.styles.s2 = style("s2", 2, "#00ff00");
    let answerMap: (map: MapResponse) => void = () => undefined;
    server.map = new Promise<MapResponse>((resolve) => {
      answerMap = resolve;
    });
    const created = follow([change("s2", 1, { listChanged: true })]);
    const edited = follow([change("s2", 2)]);
    await waitFor(() => expect(mapReads()).toHaveLength(2));
    // The map as it was between the two writes.
    answerMap(mapOf({ "7": style("s2", 1, "#cccccc"), "8": style("s9", 2, "#000000") }));
    await Promise.all([created, edited]);
    await waitFor(() => expect(active()).toEqual(style("s2", 2, "#00ff00")));
    expect(styleReads()).toEqual(["style 7/s2", "style 7/s2"]);
    expect(mapReads()).toHaveLength(2);
  });

  it("re-reads the map when the changed style is gone", async () => {
    await open();
    await expect(follow([change("gone", 3)])).resolves.toBeUndefined();
    expect(styleReads()).toEqual(["style 7/gone"]);
    expect(mapReads()).toHaveLength(2);
  });

  it("does not re-read a viewer's map", async () => {
    await open(false);
    expect(getMapBridge(PROJECT)?.isEditor).toBe(false);
    server.styles.s2 = style("s2", 1, "#00ff00");
    await follow([change("s2", 1, { listChanged: true }), change("s1", 5)]);
    expect(mapReads()).toHaveLength(1);
    await waitFor(() => expect(active()?.revision).toBe(5));
  });

  it("settle sends the page's pending style save and resolves once it is stored", async () => {
    await open();
    const key = { projectId: PROJECT, layerProjectId: 7, styleId: "s1" };
    const store = registry!.acquire(key, { document: doc("#cccccc"), revision: 4 });
    const read = fetchMock.getMockImplementation()!;
    let stored: () => void = () => undefined;
    const puts: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return read(url, init);
      puts.push(url);
      await new Promise<void>((resolve) => (stored = resolve));
      return answer(200, style("s1", 5, "#ff0000"));
    });
    store.set("symbol.fill.color", "#ff0000");
    let settled = false;
    const settling = getMapBridge(PROJECT)!
      .settle()
      .then(() => (settled = true));
    // Sent at once, not after the panel's debounce.
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(settled).toBe(false);
    stored();
    await settling;
    expect(store.saver.pending).toBe(false);
    registry!.release(key);
  });

  it("settle sends the page's pending scene save and resolves once it is stored", async () => {
    await open();
    const read = fetchMock.getMockImplementation()!;
    let stored: () => void = () => undefined;
    const puts: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return read(url, init);
      puts.push(url);
      await new Promise<void>((resolve) => (stored = resolve));
      return answer(200, { scene: { buildings: false } });
    });
    act(() => sceneStore!.set("scene.buildings", false));
    let settled = false;
    const settling = getMapBridge(PROJECT)!
      .settle()
      .then(() => (settled = true));
    // Sent at once, not after the scene's debounce.
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(settled).toBe(false);
    stored();
    await settling;
    expect(settled).toBe(true);
  });

  it("settle ends after its time when the scene save gets no answer, and never rejects", async () => {
    await open();
    const read = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return read(url, init);
      throw new Error("offline");
    });
    act(() => sceneStore!.set("scene.buildings", false));
    await expect(getMapBridge(PROJECT)!.settle(50)).resolves.toBeUndefined();
  });

  it("re-reads rows, groups, project and map as the change says, each once", async () => {
    await open();
    requests = [];
    await followMap({ layers: true, state: true, groups: true, basemap: true, scene: true });
    expect([...requests].sort()).toEqual(["groups", "layers", "map", "project"]);
    requests = [];
    await followMap({ layers: true });
    expect(requests).toEqual(["layers"]);
    requests = [];
    await followMap({ state: true });
    expect(requests).toEqual(["map"]);
    requests = [];
    await followMap({ basemap: true, groups: true });
    expect([...requests].sort()).toEqual(["groups", "project"]);
    requests = [];
    await followMap({});
    expect(requests).toEqual([]);
  });

  it("draws the style the re-read map request carries, without reading the style itself", async () => {
    // An answer changed the active style while no chat followed it: the page reads its map once.
    await open();
    server.map = mapOf({ "7": style("s1", 5, "#ff0000"), "8": style("s9", 2, "#000000") });
    requests = [];
    await followMap({ state: true });
    await waitFor(() => expect(active()?.revision).toBe(5));
    expect(active()?.document).toEqual(doc("#ff0000"));
    expect(requests).toEqual(["map"]);
  });

  it("a map change of another project is ignored", async () => {
    await open();
    requests = [];
    await getMapBridge(PROJECT)!.followMap(
      mapChange({ projectId: OTHER, layers: true, state: true, groups: true, basemap: true, scene: true })
    );
    expect(requests).toEqual([]);
  });

  it("a viewer's tab never re-reads the map document", async () => {
    await open(false);
    requests = [];
    await followMap({ layers: true, state: true, groups: true, basemap: true, scene: true });
    expect(requests).toEqual([]);
    // A view is page state: it is applied for a viewer too.
    const undo = getMapBridge(PROJECT)!.applyView({ camera: { center: [13.4, 52.5], zoom: 12 } });
    expect(mapRef.current!.flyTo).toHaveBeenCalledWith({ center: [13.4, 52.5], zoom: 12 });
    expect(undo).toBeTypeOf("function");
    expect(requests).toEqual([]);
  });

  it("gives the re-read scene to the scene store and sends nothing for it", async () => {
    await open();
    expect(shownScene()).toEqual({ buildings: true });
    const before = await server.map;
    server.map = {
      ...before,
      map: { ...before.map, scene: { buildings: false, terrain: { exaggeration: 2 } } },
    };
    requests = [];
    await act(() => followMap({ scene: true }));
    expect(requests).toEqual(["map"]);
    expect(shownScene()).toEqual({ buildings: false, terrain: { exaggeration: 2 } });
    expect(sceneStore!.canUndo).toBe(false);
    // A map change that is not the scene's leaves the scene store alone.
    server.map = { ...before, map: { ...before.map, scene: null } };
    await act(() => followMap({ state: true }));
    expect(shownScene()).toEqual({ buildings: false, terrain: { exaggeration: 2 } });
    // An automatic scene empties it.
    await act(() => followMap({ scene: true }));
    expect(shownScene()).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(requests).not.toContain("put scene");
  });

  it("follows a map change after the style change before it, not beside it", async () => {
    await open();
    server.styles.s2 = style("s2", 1, "#00ff00");
    let answerMap: (map: MapResponse) => void = () => undefined;
    const before = await server.map;
    server.map = new Promise<MapResponse>((resolve) => {
      answerMap = resolve;
    });
    const created = follow([change("s2", 1, { listChanged: true })]);
    const activated = followMap({ state: true });
    await waitFor(() => expect(mapReads()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The map change's own read waits: a cache write of the style change would drop a read under way.
    expect(mapReads()).toHaveLength(2);
    answerMap(before);
    server.map = mapOf({ "7": style("s2", 1, "#00ff00"), "8": style("s9", 2, "#000000") });
    await Promise.all([created, activated]);
    expect(mapReads()).toHaveLength(3);
    await waitFor(() => expect(active()?.id).toBe("s2"));
  });

  it("applies a view on the map and through the page's view mode and projection, and puts it back", async () => {
    await open();
    vi.useFakeTimers();
    try {
      const undo = getMapBridge(PROJECT)!.applyView({
        mode: "3d",
        projection: "globe",
        camera: { zoom: 12 },
      });
      expect(redux.getState().map.view).toEqual({ projectId: PROJECT, mode: "3d", projection: "globe" });
      vi.runAllTimers();
      expect(mapRef.current!.flyTo).toHaveBeenCalledWith({ center: [11.5, 48.1], zoom: 12, pitch: 55 });
      (undo as () => void)();
      vi.runAllTimers();
      expect(redux.getState().map.view).toEqual({ projectId: PROJECT, mode: "2d", projection: "mercator" });
      expect(mapRef.current!.flyTo).toHaveBeenLastCalledWith({
        center: [11.5, 48.1],
        zoom: 9,
        bearing: 0,
        pitch: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts the view back on the map the page draws now, after it drew a new one", async () => {
    await open();
    const first = mapRef.current!;
    const undo = getMapBridge(PROJECT)!.applyView({ camera: { center: [13.4, 52.5], zoom: 12 } });
    expect(first.flyTo).toHaveBeenCalledTimes(1);
    // A switch to Workflows and back: the page draws a new map.
    const again = fakeMap({ lng: 13.4, lat: 52.5, zoom: 12 });
    mapRef.current = again;
    (undo as () => void)();
    expect(first.flyTo).toHaveBeenCalledTimes(1);
    expect(again.flyTo).toHaveBeenCalledWith({ center: [11.5, 48.1], zoom: 9, bearing: 0, pitch: 0 });
  });

  it("leaves the map in 2D where 3D would be drawn in software, as the View button does", async () => {
    graphics.value = "software";
    await open();
    getMapBridge(PROJECT)!.applyView({ mode: "3d", camera: { zoom: 12 } });
    expect(redux.getState().map.view?.mode).toBe("2d");
    expect(mapRef.current!.flyTo).toHaveBeenCalledWith({ center: [11.5, 48.1], zoom: 12 });
  });

  it("applies no view while the map is not ready, outside Map mode, or when the page's view is another project's", async () => {
    await open();
    const map = mapRef.current!;
    redux.dispatch(setMapMode("builder"));
    expect(getMapBridge(PROJECT)!.applyView({ camera: { zoom: 12 } })).toBeUndefined();
    expect(map.flyTo).not.toHaveBeenCalled();
    redux.dispatch(setMapMode("data"));
    mapRef.current = null;
    expect(getMapBridge(PROJECT)!.applyView({ mode: "3d" })).toBeUndefined();
    expect(redux.getState().map.view?.mode).toBe("2d");
    mapRef.current = map;
    redux.dispatch(initView({ projectId: OTHER, mode: "2d", projection: "mercator" }));
    expect(getMapBridge(PROJECT)!.applyView({ mode: "3d", camera: { zoom: 12 } })).toBeUndefined();
    expect(redux.getState().map.view?.mode).toBe("2d");
    expect(map.flyTo).not.toHaveBeenCalled();
  });
});
