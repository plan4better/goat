import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AssistantMessage } from "@/lib/assistant/types";

import { useLayerAddRefresh } from "@/components/assistant/useLayerAddRefresh";

const refresh = vi.fn(async (_projectId: string) => undefined);
vi.mock("@/lib/assistant/addToProject", async (original) => ({
  ...(await original<typeof import("@/lib/assistant/addToProject")>()),
  refreshProjectLayers: (projectId: string) => refresh(projectId),
}));

const added = (id: string, toolName: string, layers: number[]): AssistantMessage =>
  ({
    id,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName,
        toolCallId: `${id}-call`,
        state: "output-available",
        input: {},
        output: { project_id: "p1", layers: layers.map((n) => ({ layer_project_id: n, name: "L" })) },
      },
    ],
  }) as unknown as AssistantMessage;

describe("useLayerAddRefresh", () => {
  it("reads the project's layers again after an add, once", () => {
    refresh.mockClear();
    const { rerender } = renderHook(({ messages }) => useLayerAddRefresh(messages, []), {
      initialProps: { messages: [] as AssistantMessage[] },
    });
    rerender({ messages: [added("m1", "project_add_dataset", [12])] });
    rerender({ messages: [added("m1", "project_add_dataset", [12])] });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("p1");
  });

  it("covers the catalog add too and skips adds the chat mounted with", () => {
    refresh.mockClear();
    const before = [added("m0", "project_add_catalog_layer", [3])];
    const { rerender } = renderHook(({ messages }) => useLayerAddRefresh(messages, before), {
      initialProps: { messages: before },
    });
    rerender({ messages: [...before, added("m1", "project_add_catalog_layer", [4])] });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores an add without new layers", () => {
    refresh.mockClear();
    const { rerender } = renderHook(({ messages }) => useLayerAddRefresh(messages, []), {
      initialProps: { messages: [] as AssistantMessage[] },
    });
    rerender({ messages: [added("m1", "project_add_dataset", [])] });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("ignores other tools and steps that are still running", () => {
    refresh.mockClear();
    const running = added("m2", "project_add_dataset", [12]);
    (running.parts[0] as { state: string }).state = "input-available";
    const { rerender } = renderHook(({ messages }) => useLayerAddRefresh(messages, []), {
      initialProps: { messages: [] as AssistantMessage[] },
    });
    rerender({ messages: [added("m1", "workflow_create", [12]), running] });
    expect(refresh).not.toHaveBeenCalled();
  });
});
