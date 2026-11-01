import type { DynamicToolUIPart } from "ai";
import { describe, expect, it, vi } from "vitest";

import {
  type OpenCreatedWorkflowDeps,
  createdWorkflow,
  createdWorkflows,
  openCreatedWorkflow,
  workflowHref,
} from "@/lib/assistant/createdWorkflows";
import type { AssistantMessage } from "@/lib/assistant/types";

const OUTPUT = {
  workflow: { id: "w-new", name: "Schools: 15-minute walk", project_id: "p1" },
  open_issues: [],
  groups: [],
};
const step = (
  toolCallId: string,
  output: unknown,
  toolName = "workflow_create",
  state = "output-available"
): DynamicToolUIPart =>
  ({
    type: "dynamic-tool",
    toolName,
    toolCallId,
    state,
    input: {},
    ...(state === "output-available" ? { output } : {}),
  }) as DynamicToolUIPart;

describe("created workflows", () => {
  it("are read from finished create steps only", () => {
    expect(createdWorkflow(step("c1", OUTPUT))).toEqual({
      id: "w-new",
      projectId: "p1",
      name: "Schools: 15-minute walk",
    });
    expect(createdWorkflow(step("c2", OUTPUT, "workflow_create_from_template"))).toMatchObject({
      id: "w-new",
    });
    expect(createdWorkflow(step("c3", OUTPUT, "core_show_items"))).toBeNull();
    expect(createdWorkflow(step("c4", undefined, "workflow_create", "input-available"))).toBeNull();
    expect(createdWorkflow(step("c5", { workflow: { id: "w-new" } }))).toBeNull();
  });

  it("are listed from the answers, in order", () => {
    const messages: AssistantMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Build it" }] },
      { id: "a1", role: "assistant", parts: [step("c1", OUTPUT), { type: "text", text: "Done." }] },
      {
        id: "a2",
        role: "assistant",
        parts: [
          step(
            "c2",
            { ...OUTPUT, workflow: { ...OUTPUT.workflow, id: "w-2" } },
            "workflow_create_from_template"
          ),
        ],
      },
    ];
    expect(createdWorkflows(messages).map((workflow) => workflow.id)).toEqual(["w-new", "w-2"]);
  });

  it("open in Workflows mode by the URL the map page reads", () => {
    expect(workflowHref("p1", "w/1")).toBe("/map/p1?mode=workflows&workflow=w%2F1");
  });
});

describe("openCreatedWorkflow", () => {
  const TARGET = { projectId: "p1", workflowId: "w-new" };
  const deps = (over: Partial<OpenCreatedWorkflowDeps> = {}) => ({
    openProjectId: () => "p1" as string | null,
    hasUnsavedChanges: () => false,
    refreshList: vi.fn(async (_projectId: string) => undefined as unknown),
    navigate: vi.fn((_href: string) => undefined),
    ...over,
  });

  it("reads the workflow list again before it opens the workflow", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const d = deps({
      refreshList: vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            release = () => {
              order.push("refreshed");
              resolve(undefined);
            };
          })
      ),
      navigate: vi.fn(() => {
        order.push("opened");
      }),
    });
    const opening = openCreatedWorkflow(TARGET, d);
    await Promise.resolve();
    expect(d.navigate).not.toHaveBeenCalled();
    release();
    await expect(opening).resolves.toBe(true);
    expect(order).toEqual(["refreshed", "opened"]);
    expect(d.refreshList).toHaveBeenCalledWith("p1");
    expect(d.navigate).toHaveBeenCalledWith("/map/p1?mode=workflows&workflow=w-new");
  });

  it("leaves a workflow of another project, or outside a project, to its card", async () => {
    for (const open of ["p2", null]) {
      const d = deps({ openProjectId: () => open });
      await expect(openCreatedWorkflow(TARGET, d)).resolves.toBe(false);
      expect(d.refreshList).not.toHaveBeenCalled();
      expect(d.navigate).not.toHaveBeenCalled();
    }
  });

  it("leaves the editor alone while it holds unsaved changes", async () => {
    const d = deps({ hasUnsavedChanges: () => true });
    await expect(openCreatedWorkflow(TARGET, d)).resolves.toBe(false);
    expect(d.navigate).not.toHaveBeenCalled();
  });

  it("does not open when editing started, or the project was left, while the list was read", async () => {
    let dirty = false;
    const edited = deps({
      hasUnsavedChanges: () => dirty,
      refreshList: vi.fn(async () => {
        dirty = true;
      }),
    });
    await expect(openCreatedWorkflow(TARGET, edited)).resolves.toBe(false);
    expect(edited.navigate).not.toHaveBeenCalled();

    let project: string | null = "p1";
    const left = deps({
      openProjectId: () => project,
      refreshList: vi.fn(async () => {
        project = "p2";
      }),
    });
    await expect(openCreatedWorkflow(TARGET, left)).resolves.toBe(false);
    expect(left.navigate).not.toHaveBeenCalled();
  });

  it("does not open on a list it could not read", async () => {
    const d = deps({
      refreshList: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await expect(openCreatedWorkflow(TARGET, d)).resolves.toBe(false);
    expect(d.navigate).not.toHaveBeenCalled();
  });
});
