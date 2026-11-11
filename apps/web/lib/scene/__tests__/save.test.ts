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
