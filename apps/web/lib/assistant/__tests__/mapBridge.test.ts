import type { DynamicToolUIPart } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type MapBridge,
  followMapChange,
  followStyleChanges,
  getMapBridge,
  markFollowed,
  missedEdits,
  registerMapBridge,
  resetFollowedCalls,
} from "@/lib/assistant/mapBridge";
import type { MapChange } from "@/lib/assistant/mapEdits";
import type { StyleChange } from "@/lib/assistant/styleEdits";
import type { AssistantMessage } from "@/lib/assistant/types";

const bridge = (
  projectId: string,
  followStyles = vi.fn(async () => undefined),
  followMap = vi.fn(async () => undefined)
): MapBridge => ({
  projectId,
  isEditor: true,
  followStyles,
  settle: vi.fn(async () => undefined),
  followMap,
  applyView: vi.fn(),
});
const mapChange = (projectId: string): MapChange => ({
  projectId,
  layers: true,
  state: false,
  groups: false,
  basemap: false,
  scene: false,
});
const change = (projectId: string, styleId = "s1"): StyleChange => ({
  projectId,
  layerProjectId: 7,
  styleId,
  revision: 5,
  listChanged: false,
});

const registered: Array<() => void> = [];
const register = (next: MapBridge) => {
  const remove = registerMapBridge(next);
  registered.push(remove);
  return remove;
};

afterEach(() => {
  resetFollowedCalls();
  registered.splice(0).forEach((remove) => remove());
  vi.restoreAllMocks();
});

describe("the map bridge", () => {
  it("getMapBridge answers null after the page unregistered", () => {
    expect(getMapBridge()).toBeNull();
    const page = bridge("p1");
    const remove = register(page);
    expect(getMapBridge()).toBe(page);
    remove();
    expect(getMapBridge()).toBeNull();
    expect(getMapBridge("p1")).toBeNull();
  });

  it("answers the bridge of a project only while a map page shows that project", () => {
    const page = bridge("p1");
    register(page);
    expect(getMapBridge("p1")).toBe(page);
    expect(getMapBridge("p2")).toBeNull();
  });

  it("the newest registration wins; unregistering an older one changes nothing", () => {
    const first = bridge("p1");
    const second = bridge("p2");
    const removeFirst = register(first);
    register(second);
    expect(getMapBridge()).toBe(second);
    removeFirst();
    expect(getMapBridge()).toBe(second);
  });

  it("hands each project's style changes to the map page that shows it", () => {
    const page = bridge("p1");
    register(page);
    followStyleChanges([change("p1"), change("p2"), change("p1", "s2")]);
    expect(page.followStyles).toHaveBeenCalledTimes(1);
    expect(page.followStyles).toHaveBeenCalledWith([change("p1"), change("p1", "s2")]);
  });

  it("does nothing without a map page, and logs a follow that fails", async () => {
    expect(() => followStyleChanges([change("p1")])).not.toThrow();
    const failure = new Error("down");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    register(bridge("p1", vi.fn().mockRejectedValue(failure)));
    expect(() => followStyleChanges([change("p1")])).not.toThrow();
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    expect(logged.mock.calls[0]).toContain(failure);
  });

  it("hands a map change to the map page that shows its project, and logs a follow that fails", async () => {
    expect(() => followMapChange(mapChange("p1"))).not.toThrow();
    const failure = new Error("down");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const page = bridge("p1", undefined, vi.fn().mockRejectedValue(failure));
    register(page);
    followMapChange(mapChange("p2"));
    expect(page.followMap).not.toHaveBeenCalled();
    expect(() => followMapChange(mapChange("p1"))).not.toThrow();
    expect(page.followMap).toHaveBeenCalledWith(mapChange("p1"));
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    expect(logged.mock.calls[0]).toContain(failure);
  });
});

const styled = (toolCallId: string, styleId: string, after: number, projectId = "p1"): DynamicToolUIPart =>
  ({
    type: "dynamic-tool",
    toolName: "style_update",
    toolCallId,
    state: "output-available",
    input: {},
    output: {
      project_id: projectId,
      layer_project_id: 7,
      style_id: styleId,
      created: false,
      made_active: false,
      revision_before: after - 1,
      revision_after: after,
    },
  }) as DynamicToolUIPart;
const mapped = (toolCallId: string, op: string): DynamicToolUIPart =>
  ({
    type: "dynamic-tool",
    toolName: "map_update",
    toolCallId,
    state: "output-available",
    input: {},
    output: { project_id: "p1", applied: [{ index: 0, op, summary: op }] },
  }) as DynamicToolUIPart;
const answer = (id: string, parts: DynamicToolUIPart[]): AssistantMessage => ({
  id,
  role: "assistant",
  parts,
});
const asked: AssistantMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "?" }] };
const plain = (more: Partial<MapChange>): MapChange => ({
  projectId: "p1",
  layers: false,
  state: false,
  groups: false,
  basemap: false,
  scene: false,
  ...more,
});

describe("what the newest answer changed that this tab did not follow", () => {
  it("is one plain re-read per project, for the newest answer only, once", () => {
    const tenEdits = Array.from({ length: 10 }, (_, index) =>
      styled(`s-${index}`, index % 2 ? "s1" : "s2", index + 2)
    );
    const messages = [
      answer("a0", [styled("old", "s9", 3, "p2")]),
      asked,
      answer("a1", [...tenEdits, mapped("m-1", "set_basemap"), mapped("v-1", "set_view")]),
    ];
    // The styles come with the map request: its re-read, no read of a style.
    expect(missedEdits(messages)).toEqual([plain({ state: true, basemap: true })]);
    expect(missedEdits(messages)).toEqual([]);
  });

  it("leaves out the steps this tab followed as they came in, and the map steps when asked to", () => {
    markFollowed("s-1");
    expect(missedEdits([answer("a1", [styled("s-1", "s1", 5)])])).toEqual([]);
    expect(missedEdits([answer("a2", [mapped("m-2", "set_basemap")])], { map: false })).toEqual([]);
    expect(missedEdits([answer("a2", [mapped("m-2", "set_basemap")])])).toEqual([plain({ basemap: true })]);
    expect(missedEdits([asked])).toEqual([]);
  });
});
