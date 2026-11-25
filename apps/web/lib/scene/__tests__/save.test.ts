// The scene's save loop (3D spec 8.2): editors' changes go to the project after a second, the last one wins; viewers'
// stay local. The view mode and projection live in the map slice per project.
import { configureStore } from "@reduxjs/toolkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { putScene } from "@/lib/api/map";
import { LocalSaver, type PutScene, SceneSaver } from "@/lib/scene/save";
import { initView, mapReducer, setProjection, setViewMode } from "@/lib/store/map/slice";
import { EditorStore } from "@/lib/style/editor/store";
import type { StyleIssue } from "@/lib/style/save";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/api/fetcher", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiRequestAuth: request,
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  request.mockReset();
});

const warning: StyleIssue = {
  level: "error",
  code: "invalid_value",
  path: "/scene/light/day",
  message: "April has 30 days.",
};

describe("SceneSaver", () => {
  it("sends two quick edits as one save with the last document and keeps the issues", async () => {
    const put = vi.fn<PutScene>(async () => ({ stored: false, scene: null, issues: [warning] }));
    const saver = new SceneSaver({ document: { scene: {} }, put });
    saver.edit({ scene: { buildings: false } });
    await vi.advanceTimersByTimeAsync(500);
    saver.edit({ scene: { buildings: false, terrain: { exaggeration: 2 } } });
    await vi.advanceTimersByTimeAsync(999);
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith({ buildings: false, terrain: { exaggeration: 2 } });
    expect(saver.issues).toEqual([warning]);
    // A refused scene is not sent again until the next edit.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("settle sends a waiting change at once and resolves once it is stored, or after its time", async () => {
    let answer: (v: Awaited<ReturnType<PutScene>>) => void = () => undefined;
    const put = vi.fn<PutScene>(() => new Promise((resolve) => (answer = resolve)));
    const saver = new SceneSaver({ document: { scene: {} }, put });
    let settled = false;
    await expect(saver.settle()).resolves.toBeUndefined();
    saver.edit({ scene: { buildings: false } });
    void saver.settle().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    answer({ stored: true, scene: { buildings: false }, issues: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);

    // No answer: the save retries later, and the wait ends at its time.
    put.mockRejectedValue(new Error("offline"));
    saver.edit({ scene: { buildings: true } });
    settled = false;
    void saver.settle(3000).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(saver.pending).toBe(true);
  });

  it("sends null for an empty scene", async () => {
    const put = vi.fn<PutScene>(async (scene) => ({ stored: true, scene, issues: [] }));
    const saver = new SceneSaver({ document: { scene: { buildings: true } }, put });
    saver.edit({ scene: { sky: undefined } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledWith(null);
    expect(saver.issues).toEqual([]);
  });

  it("keeps one save in flight and sends the edits made meanwhile after it", async () => {
    let answer: (v: Awaited<ReturnType<PutScene>>) => void = () => undefined;
    const put = vi.fn<PutScene>(() => new Promise((resolve) => (answer = resolve)));
    const saver = new SceneSaver({ document: { scene: {} }, put });
    saver.edit({ scene: { buildings: false } });
    await vi.advanceTimersByTimeAsync(1000);
    saver.edit({ scene: { buildings: true } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(put).toHaveBeenCalledTimes(1);
    answer({ stored: true, scene: { buildings: false }, issues: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith({ buildings: true });
  });

  it("retries a failed save", async () => {
    const put = vi
      .fn<PutScene>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ stored: true, scene: { buildings: false }, issues: [] });
    const saver = new SceneSaver({ document: { scene: {} }, put });
    saver.edit({ scene: { buildings: false } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(put).toHaveBeenCalledTimes(2);
    expect(saver.pending).toBe(false);
  });
});

describe("putScene", () => {
  it.each([
    ["a scene over its limit", 422, { detail: { code: "scene_too_large" } }],
    ["a body over the cap", 413, { detail: { code: "body_too_large" } }],
    ["a proxy's 413", 413, null],
  ])(
    "%s is a refusal: nothing stored, no issues, and the saver does not send it again",
    async (_, status, body) => {
      request.mockImplementation(
        async () => new Response(body === null ? "" : JSON.stringify(body), { status: status as number })
      );
      await expect(putScene("p1", { buildings: false })).resolves.toEqual({
        stored: false,
        scene: null,
        issues: [],
      });
      request.mockClear();
      const saver = new SceneSaver({ document: { scene: {} }, put: (scene) => putScene("p1", scene) });
      saver.edit({ scene: { buildings: false } });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(request).toHaveBeenCalledTimes(1);
      expect(saver.pending).toBe(false);
    }
  );

  it("puts the scene on the project and reads a refusal's issues", async () => {
    request.mockResolvedValueOnce(new Response(JSON.stringify({ id: "p1", name: "P" }), { status: 200 }));
    await expect(putScene("p1", null)).resolves.toEqual({ stored: true, scene: null, issues: [] });
    const [url, init] = request.mock.calls[0];
    expect(String(url)).toMatch(/\/project\/p1$/);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ scene: null });

    request.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { code: "invalid_scene", issues: [warning] } }), { status: 422 })
    );
    await expect(putScene("p1", { light: { direction: 90 } })).resolves.toEqual({
      stored: false,
      scene: null,
      issues: [warning],
    });

    request.mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(putScene("p1", {})).rejects.toThrow();
  });
});

describe("LocalSaver", () => {
  it("keeps a viewer's changes in the browser, with undo", () => {
    const saver = new LocalSaver({ scene: {} });
    const store = new EditorStore({ saver: saver as never });
    store.set("scene.terrain.exaggeration", 2);
    expect(saver.document).toEqual({ scene: { terrain: { exaggeration: 2 } } });
    store.undo();
    expect(store.get("scene.terrain")).toBeUndefined();
    expect((store.document as unknown as { scene: object }).scene).toEqual({});
  });
});

describe("receive", () => {
  const stored = (scene: object | null) => ({ stored: true, scene: scene as never, issues: [] });

  it("receive makes the stored scene the base without sending it", async () => {
    const put = vi.fn<PutScene>(async (scene) => stored(scene));
    const saver = new SceneSaver({ document: { scene: { buildings: true } }, put });
    const store = new EditorStore({ saver: saver as never });
    const told = vi.fn();
    store.subscribe(told);
    saver.receive({ buildings: false, terrain: { exaggeration: 2 } });
    expect(saver.document).toEqual({ scene: { buildings: false, terrain: { exaggeration: 2 } } });
    expect(saver.pending).toBe(false);
    // The scene store shows it, and it is no step of the store's undo.
    expect(store.get("scene.terrain.exaggeration")).toBe(2);
    expect(told).toHaveBeenCalled();
    expect(store.canUndo).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(put).not.toHaveBeenCalled();

    // The next edit is taken against the received scene: undoing it by hand leaves nothing to send.
    saver.edit({ scene: { buildings: true, terrain: { exaggeration: 2 } } });
    saver.edit({ scene: { buildings: false, terrain: { exaggeration: 2 } } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(put).not.toHaveBeenCalled();

    // An automatic scene (null) empties the document.
    saver.receive(null);
    expect(saver.document).toEqual({ scene: {} });
    expect(saver.pending).toBe(false);
  });

  it("receive keeps a local scene edit that is not sent yet", async () => {
    let answer: (v: Awaited<ReturnType<PutScene>>) => void = () => undefined;
    const put = vi.fn<PutScene>(() => new Promise((resolve) => (answer = resolve)));
    const saver = new SceneSaver({ document: { scene: {} }, put });
    const store = new EditorStore({ saver: saver as never });
    store.set("scene.buildings", false);
    saver.receive({ terrain: { exaggeration: 2 } });
    expect(saver.document).toEqual({ scene: { buildings: false } });
    expect(store.get("scene.buildings")).toBe(false);
    expect(put).not.toHaveBeenCalled();
    // The local scene goes out after its own wait, not because of the receive.
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith({ buildings: false });

    // A save under way keeps its document too.
    saver.receive({ terrain: { exaggeration: 3 } });
    expect(saver.document).toEqual({ scene: { buildings: false } });
    answer(stored({ buildings: false }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(put).toHaveBeenCalledTimes(1);
    expect(saver.pending).toBe(false);
  });

  it("receive keeps the document while a save is under way, also one edited back to the stored scene", async () => {
    let answer: (v: Awaited<ReturnType<PutScene>>) => void = () => undefined;
    const put = vi.fn<PutScene>(() => new Promise((resolve) => (answer = resolve)));
    const saver = new SceneSaver({ document: { scene: {} }, put });
    saver.edit({ scene: { buildings: false } });
    await vi.advanceTimersByTimeAsync(1000);
    saver.edit({ scene: {} });
    saver.receive({ terrain: { exaggeration: 2 } });
    expect(saver.document).toEqual({ scene: {} });
    // The reply stores what was sent; the document, edited since, goes out after it.
    answer(stored({ buildings: false }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith(null);
  });

  it("receive keeps a scene the server refused on screen", async () => {
    const put = vi.fn<PutScene>(async () => ({ stored: false, scene: null, issues: [warning] }));
    const saver = new SceneSaver({ document: { scene: {} }, put });
    saver.edit({ scene: { light: { direction: 400 } } } as never);
    await vi.advanceTimersByTimeAsync(1000);
    saver.receive({ buildings: false });
    expect(saver.document).toEqual({ scene: { light: { direction: 400 } } });
    expect(saver.issues).toEqual([warning]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("a viewer's scene takes the stored one unless the viewer changed it", () => {
    const saver = new LocalSaver({ scene: {} });
    saver.receive({ buildings: false });
    expect(saver.document).toEqual({ scene: { buildings: false } });
    saver.edit({ scene: { buildings: false, terrain: false } });
    saver.receive({ buildings: true });
    expect(saver.document).toEqual({ scene: { buildings: false, terrain: false } });
  });
});

describe("view mode in the map slice", () => {
  it("is set per project and changed by its actions", () => {
    const store = configureStore({ reducer: { map: mapReducer } });
    expect(store.getState().map.view).toBeUndefined();
    store.dispatch(setViewMode("3d"));
    expect(store.getState().map.view).toBeUndefined();
    store.dispatch(initView({ projectId: "p1", mode: "2d", projection: "mercator" }));
    store.dispatch(setViewMode("3d"));
    store.dispatch(setProjection("globe"));
    expect(store.getState().map.view).toEqual({ projectId: "p1", mode: "3d", projection: "globe" });
  });
});
