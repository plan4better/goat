import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DynamicToolUIPart } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import { AssistantRequestError } from "@/lib/assistant/errors";
import { resetAssistantStore } from "@/lib/assistant/store";
import type { AssistantMessage } from "@/lib/assistant/types";

import { DockActionsContext } from "@/components/assistant/DockActions";
import { dockActions } from "@/components/assistant/__tests__/helpers";
import MessageList from "@/components/assistant/messages/MessageList";
import { resetUndoneAnswers } from "@/components/assistant/messages/UndoAnswer";

const { undoAnswer, toast } = vi.hoisted(() => ({
  undoAnswer: vi.fn(),
  toast: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/assistant/transport", () => ({ undoAnswer, saveFeedback: vi.fn() }));
vi.mock("react-toastify", () => ({ toast }));
vi.mock("react-i18next", async () => {
  const { commonI18n } = await import("@/i18n/__tests__/commonI18n");
  const i18n = commonI18n("en");
  const t = i18n.getFixedT("en", "common");
  return { useTranslation: () => ({ t, i18n }) };
});
vi.mock("@/lib/api/users", () => ({ useFeatures: () => ({ features: { billing: true } }) }));

const actions = dockActions();

const nothing = { workflows: [], styles: [], map: null, notRestored: [] };
const noneChanged = { workflows: [], styles: [], map: [] };

const workflowUpdate = (id = "u-1") =>
  ({
    type: "dynamic-tool",
    toolName: "workflow_update",
    toolCallId: id,
    state: "output-available",
    input: { workflow_id: "wf-1", operations: [] },
    output: { workflow_id: "wf-1", revision_before: 4, revision_after: 5, changed_steps: [] },
  }) as DynamicToolUIPart;
const styleUpdate = (id = "s-1") =>
  ({
    type: "dynamic-tool",
    toolName: "style_update",
    toolCallId: id,
    state: "output-available",
    input: {},
    output: {
      project_id: "p1",
      layer_project_id: 12,
      style_id: "st-1",
      created: false,
      made_active: false,
      revision_before: 4,
      revision_after: 5,
    },
  }) as DynamicToolUIPart;
const mapUpdate = (id = "m-1", applied: unknown[] = [hidden]) =>
  ({
    type: "dynamic-tool",
    toolName: "map_update",
    toolCallId: id,
    state: "output-available",
    input: {},
    output: { project_id: "p1", applied },
  }) as DynamicToolUIPart;
const hidden = { index: 0, op: "set_layer", layer_project_id: 13, fields: ["visible"], summary: "Hidden" };
const removed = { index: 0, op: "remove_layer", layer_project_id: 12, summary: "Removed Parks" };
const read = (id: string) =>
  ({
    type: "dynamic-tool",
    toolName: "project_get_layers",
    toolCallId: id,
    state: "output-available",
    input: {},
    output: { name: "Walk", layers: [] },
  }) as DynamicToolUIPart;
const typed = (output: Record<string, unknown>) =>
  ({
    type: "dynamic-tool",
    toolName: "undo_changes",
    toolCallId: "t-1",
    state: "output-available",
    input: {},
    output: { workflows: [], styles: [], not_restored: [], summary: "…", ...output },
  }) as DynamicToolUIPart;
const text = { type: "text", text: "Done." } as const;

const answer = (
  parts: AssistantMessage["parts"],
  metadata: AssistantMessage["metadata"] = { run_id: "run-1" },
  id = "a1"
): AssistantMessage => ({ id, role: "assistant", metadata, parts });
const question: AssistantMessage = { id: "q2", role: "user", parts: [{ type: "text", text: "Undo that" }] };

const list = (messages: AssistantMessage[]) => (
  <DockActionsContext.Provider value={actions}>
    <MessageList
      messages={messages}
      busy={false}
      conversationId="c1"
      conversationProjectId="p1"
      projectName="Walk"
      readOnly={false}
    />
  </DockActionsContext.Provider>
);
const show = (messages: AssistantMessage[]) => render(list(messages));

const undoButton = () => screen.getByRole("button", { name: "Undo" });
/** The line of a step: its row button and what sits beside it. */
const rowOf = (label: string | RegExp) =>
  screen.getByRole("button", { name: label }).parentElement as HTMLElement;
/** The action row under the answer. */
const actionRow = () =>
  screen.getByRole("button", { name: "Copy answer" }).closest(".answer-actions") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  actions.unsavedWorkflowChanges.mockReturnValue(false);
  resetUndoneAnswers();
  resetAssistantStore();
});

describe("Undo on the change itself", () => {
  it("sits at the end of the change's line, not in the action row, and nests in no button", () => {
    const { container } = show([answer([workflowUpdate(), text])]);
    const button = undoButton();
    expect(within(rowOf("Changed the workflow")).getByRole("button", { name: "Undo" })).toBe(button);
    expect(actionRow().contains(button)).toBe(false);
    expect(within(actionRow()).getByRole("button", { name: "Copy answer" })).toBeTruthy();
    expect(container.querySelector("button button")).toBeNull();
    // The hint is its tooltip.
    expect(button.closest("[title]")?.getAttribute("title")).toBe("Undo this answer's changes");
  });

  it("sits on the last of several change rows, once per answer", () => {
    show([answer([workflowUpdate(), styleUpdate(), mapUpdate(), text])]);
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    expect(within(rowOf("Changed the map")).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(rowOf("Changed the workflow")).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(within(rowOf("Changed the style")).queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("sits on the last change of the answer's last group, whether its reads are folded or open", () => {
    // Two groups: the first with a change, the second (after the text) with reads and the last change.
    show([answer([styleUpdate("s-1"), text, read("r-1"), read("r-2"), read("r-3"), mapUpdate("m-1"), text])]);
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    expect(within(rowOf("Changed the map")).getByRole("button", { name: "Undo" })).toBeTruthy();
    // The reads fold into a summary; the Undo is reachable without opening it, and stays one once it is open.
    const summary = screen.getByRole("button", { expanded: false, name: /Read the layers/ });
    fireEvent.click(summary);
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    expect(within(rowOf("Changed the map")).getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("shows no Undo on an answer whose only step is a typed undo", () => {
    show([question, answer([typed({ status: "undone", run_id: "run-0" }), text], { run_id: "run-2" })]);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Undid the changes" })).toBeTruthy();
  });

  it("after a click every change row reads undone and the last ends with Undone", async () => {
    undoAnswer.mockResolvedValue({
      kind: "undone",
      restored: {
        ...nothing,
        workflows: [{ workflowId: "wf-1", projectId: "p1", revision: 4 }],
        styles: [
          {
            projectId: "p1",
            layerProjectId: 12,
            styleId: "st-1",
            revision: 4,
            removed: false,
            partial: false,
          },
        ],
      },
    });
    show([answer([workflowUpdate(), styleUpdate(), text])]);
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    for (const label of ["Changed the workflow, undone", "Changed the style, undone"]) {
      const row = screen.getByRole("button", { name: label });
      expect(row.querySelector("[data-status='undone']")).toBeTruthy();
    }
    expect(within(rowOf("Changed the style, undone")).getByText("Undone")).toBeTruthy();
    expect(screen.getByText("Undone").closest("[title]")?.getAttribute("title")).toBe(
      "This answer's changes were undone: 1 workflow, 1 style"
    );
    expect(actionRow().textContent).not.toContain("Undone");
  });

  it("reads undone from the history after a reload", () => {
    show([answer([workflowUpdate(), mapUpdate(), text], { run_id: "run-1", undone: true })]);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Changed the workflow, undone" })).toBeTruthy();
    expect(within(rowOf("Changed the map, undone")).getByText("Undone")).toBeTruthy();
  });

  it("reads undone once a typed undo took the answer back, and the typed undo's row stays as it is", () => {
    const earlier = answer([styleUpdate(), text], { run_id: "run-1", undoable: true });
    const { rerender } = show([earlier]);
    expect(undoButton()).toBeTruthy();
    rerender(
      list([
        earlier,
        question,
        answer([typed({ status: "undone", run_id: "run-1" }), text], { run_id: "run-2" }, "a2"),
      ])
    );
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Changed the style, undone" })).toBeTruthy();
    expect(screen.getAllByText("Undone")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Undid the changes" })).toBeTruthy();
  });

  it("asks on one line in place of the row, and Undo anyway takes it back", async () => {
    undoAnswer.mockResolvedValueOnce({
      kind: "changed",
      restored: nothing,
      changed: {
        ...noneChanged,
        styles: [{ projectId: "p1", layerProjectId: 12, styleId: "st-1", between: false, tooOld: false }],
      },
    });
    undoAnswer.mockResolvedValueOnce({ kind: "undone", restored: nothing });
    show([answer([styleUpdate(), text])]);
    fireEvent.click(undoButton());
    const line = await screen.findByText("The style was changed after this answer edited it.");
    // The question stands in the row's place, with its longer explanation as the tooltip; no popover opens.
    expect(document.querySelector(".MuiPopover-root")).toBeNull();
    expect(screen.queryByRole("button", { name: "Changed the style" })).toBeNull();
    expect(line.closest("[title]")?.getAttribute("title")).toBe(
      "Undo anyway puts back the settings this answer changed. Later changes of the same settings are replaced, other later changes stay."
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo anyway" }));
    await screen.findByText("Undone");
    expect(undoAnswer).toHaveBeenLastCalledWith("c1", "run-1", true);
    expect(screen.getByRole("button", { name: "Changed the style, undone" })).toBeTruthy();
  });

  it("keeps everything when the question is cancelled, and the row comes back with Undo", async () => {
    undoAnswer.mockResolvedValue({
      kind: "changed",
      restored: nothing,
      changed: { ...noneChanged, map: [{ object: "filter", layerProjectId: 12 }] },
    });
    show([answer([mapUpdate(), text])]);
    fireEvent.click(undoButton());
    await screen.findByText("The map was changed after this answer edited it.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo anyway" })).toBeNull());
    expect(within(rowOf("Changed the map")).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(undoAnswer).toHaveBeenCalledTimes(1);
  });

  it("asks on that line about the editor's unsaved changes too, and goes on without force", async () => {
    actions.unsavedWorkflowChanges.mockReturnValue(true);
    undoAnswer.mockResolvedValue({ kind: "undone", restored: nothing });
    show([answer([workflowUpdate(), text])]);
    fireEvent.click(undoButton());
    const line = await screen.findByText("The workflow has changes in the editor that are not saved yet.");
    expect(line.closest("[title]")?.getAttribute("title")).toBe(
      "Undo anyway, and the editor asks which version to keep."
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo anyway" }));
    await screen.findByText("Undone");
    expect(undoAnswer).toHaveBeenCalledWith("c1", "run-1", false);
  });

  it("says visibly under the row what could not be put back, and ends with Undone, in part", async () => {
    undoAnswer.mockResolvedValue({
      kind: "undone",
      restored: {
        ...nothing,
        styles: [
          {
            projectId: "p1",
            layerProjectId: 12,
            styleId: "st-1",
            revision: 4,
            removed: false,
            partial: true,
          },
        ],
      },
    });
    show([answer([styleUpdate(), text])]);
    fireEvent.click(undoButton());
    const row = await waitFor(() => rowOf("Changed the style, undone"));
    expect(within(row).getByText("Undone, in part")).toBeTruthy();
    const note = screen.getByText(
      "A part of the style could not be put back because it no longer fits the data."
    );
    // A line of its own under the change row, not in the action row.
    expect(actionRow().contains(note)).toBe(false);
    expect(row.parentElement?.contains(note)).toBe(true);
  });

  it("says under the row that removed layers do not come back", async () => {
    undoAnswer.mockResolvedValue({
      kind: "undone",
      restored: { ...nothing, notRestored: ["layer_removed"] },
    });
    show([answer([mapUpdate("m-1", [removed, { ...hidden, index: 1 }]), text])]);
    fireEvent.click(undoButton());
    expect(await screen.findByText("Removed layers do not come back.")).toBeTruthy();
    expect(screen.getByText("Undone, in part")).toBeTruthy();
  });

  it("keeps Undo with a line under the row when core stored nothing of a style's restore", async () => {
    undoAnswer.mockResolvedValue({ kind: "undone", restored: { ...nothing, notRestored: ["style"] } });
    show([answer([styleUpdate(), text])]);
    fireEvent.click(undoButton());
    const note = await screen.findByText(
      "A style could not be put back because its earlier settings no longer fit the data."
    );
    expect(within(rowOf("Changed the style")).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(rowOf("Changed the style").parentElement?.contains(note)).toBe(true);
  });

  it("says under the row what already went back while the rest is asked about", async () => {
    undoAnswer.mockResolvedValue({
      kind: "changed",
      restored: {
        ...nothing,
        styles: [
          {
            projectId: "p1",
            layerProjectId: 12,
            styleId: "st-1",
            revision: 4,
            removed: false,
            partial: false,
          },
        ],
      },
      changed: { ...noneChanged, map: [{ object: "filter", layerProjectId: 12 }] },
    });
    show([answer([styleUpdate(), mapUpdate(), text])]);
    fireEvent.click(undoButton());
    const partly = "Already undone: 1 style. The rest of this answer's changes are still in place.";
    expect(await screen.findAllByText(partly)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo anyway" })).toBeNull());
    expect(screen.getAllByText(partly)).toHaveLength(1);
    expect(rowOf("Changed the map").parentElement?.contains(screen.getByText(partly))).toBe(true);
  });

  it("is disabled while it runs, and stays Undo on an error or another undo under way", async () => {
    let answerNow: (value: unknown) => void = () => undefined;
    undoAnswer.mockImplementationOnce(() => new Promise((resolve) => (answerNow = resolve)));
    show([answer([styleUpdate(), text])]);
    fireEvent.click(undoButton());
    await waitFor(() => expect((undoButton() as HTMLButtonElement).disabled).toBe(true));
    answerNow({ kind: "undone", restored: nothing });
    await screen.findByText("Undone");

    resetUndoneAnswers();
    undoAnswer.mockRejectedValueOnce(new AssistantRequestError(409, "undo_in_progress"));
    const second = show([answer([styleUpdate(), text], { run_id: "run-7" }, "a7")]);
    fireEvent.click(within(second.container).getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "These changes are being undone in another tab. Try again in a moment."
      )
    );
    expect(within(second.container).getByRole("button", { name: "Undo" })).toBeTruthy();

    undoAnswer.mockRejectedValueOnce(new AssistantRequestError(403, "undo_not_allowed"));
    fireEvent.click(within(second.container).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(within(second.container).getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("reads Undone with a note when the answer was undone already elsewhere", async () => {
    undoAnswer.mockRejectedValue(new AssistantRequestError(409, "already_undone"));
    show([answer([styleUpdate(), text])]);
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(toast.info).toHaveBeenCalledWith("These changes were undone already.");
    expect(screen.getByRole("button", { name: "Changed the style, undone" })).toBeTruthy();
  });

  it("keeps a visible Undo of its own for an undoable answer without a change row", async () => {
    const unfinished = {
      type: "dynamic-tool",
      toolName: "workflow_update",
      toolCallId: "u-stopped",
      state: "input-available",
      input: { workflow_id: "wf-1", operations: [] },
    } as DynamicToolUIPart;
    const stopped = { type: "data-run-status", data: { status: "cancelled", error: null, code: null } };
    undoAnswer.mockResolvedValue({ kind: "undone", restored: nothing });
    show([
      answer([unfinished, text, stopped] as AssistantMessage["parts"], { run_id: "run-1", undoable: true }),
    ]);
    const button = undoButton();
    expect(actionRow().contains(button)).toBe(false);
    // The stopped write's line is no change the steps name: the Undo stands on a line of its own.
    expect(within(rowOf(/Changing the workflow/)).queryByRole("button", { name: "Undo" })).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByText("Undone")).toBeTruthy();
  });

  it("moves focus to the question, not to Undo anyway, back to Undo on Cancel, and Escape cancels too", async () => {
    undoAnswer.mockResolvedValue({
      kind: "changed",
      restored: nothing,
      changed: { ...noneChanged, map: [{ object: "filter", layerProjectId: 12 }] },
    });
    show([answer([mapUpdate(), text])]);
    fireEvent.click(undoButton());
    const asked = await screen.findByText("The map was changed after this answer edited it.");
    expect(document.activeElement).toBe(asked);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(undoButton()));
    fireEvent.click(undoButton());
    fireEvent.keyDown(await screen.findByRole("button", { name: "Undo anyway" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo anyway" })).toBeNull());
    expect(undoAnswer).toHaveBeenCalledTimes(2);
  });

  it("keeps an opened group open when the finished answer comes to offer Undo", () => {
    const parts = [
      read("r-1"),
      read("r-2"),
      read("r-3"),
      text,
      styleUpdate(),
      text,
    ] as AssistantMessage["parts"];
    const running = (busy: boolean) => (
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[answer(parts)]}
          busy={busy}
          conversationId="c1"
          conversationProjectId="p1"
          projectName="Walk"
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    const { rerender } = render(running(true));
    fireEvent.click(screen.getByRole("button", { expanded: false, name: /Read the layers/ }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    rerender(running(false));
    expect(screen.getByRole("button", { expanded: true, name: /Read the layers/ })).toBeTruthy();
    expect(undoButton()).toBeTruthy();
  });

  it("keeps Undone in this tab for an answer mounted again while it was still running", async () => {
    undoAnswer.mockResolvedValue({ kind: "undone", restored: nothing });
    const view = show([answer([styleUpdate(), text])]);
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    view.unmount();
    const at = (busy: boolean) => (
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[answer([styleUpdate(), text])]}
          busy={busy}
          conversationId="c1"
          conversationProjectId="p1"
          projectName="Walk"
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    const { rerender } = render(at(true));
    rerender(at(false));
    expect(screen.getByText("Undone")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("drops the question once a typed undo took the answer back while it asked", async () => {
    undoAnswer.mockResolvedValue({
      kind: "changed",
      restored: nothing,
      changed: { ...noneChanged, map: [{ object: "filter", layerProjectId: 12 }] },
    });
    const earlier = answer([mapUpdate(), text]);
    const { rerender } = show([earlier]);
    fireEvent.click(undoButton());
    await screen.findByRole("button", { name: "Undo anyway" });
    rerender(
      list([
        earlier,
        question,
        answer([typed({ status: "undone", run_id: "run-1" }), text], { run_id: "run-2" }, "a2"),
      ])
    );
    expect(screen.queryByRole("button", { name: "Undo anyway" })).toBeNull();
    expect(within(rowOf("Changed the map, undone")).getByText("Undone")).toBeTruthy();
  });

  it("carries the Undo on the change beside a typed undo in one group, and never strikes the typed undo", async () => {
    undoAnswer.mockResolvedValue({ kind: "undone", restored: nothing });
    show([answer([mapUpdate(), typed({ status: "nothing", run_id: "run-0" }), text])]);
    expect(within(rowOf("Changed the map")).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(rowOf("Found nothing to undo")).queryByRole("button", { name: "Undo" })).toBeNull();
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(screen.getByRole("button", { name: "Changed the map, undone" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Found nothing to undo" })).toBeTruthy();
  });

  it("describes Undo anyway with what it does, for screen readers too", async () => {
    undoAnswer.mockResolvedValue({
      kind: "changed",
      restored: nothing,
      changed: { ...noneChanged, map: [{ object: "filter", layerProjectId: 12 }] },
    });
    show([answer([mapUpdate(), text])]);
    fireEvent.click(undoButton());
    const anyway = await screen.findByRole("button", { name: "Undo anyway" });
    const described = document.getElementById(anyway.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe(
      "Undo anyway puts back the settings this answer changed. Later changes of the same settings are replaced, other later changes stay."
    );
  });

  it("keeps focus on the row's Undone once the undo finished, after a press and after Undo anyway", async () => {
    undoAnswer.mockResolvedValueOnce({ kind: "undone", restored: nothing });
    const view = show([answer([styleUpdate(), text])]);
    undoButton().focus();
    fireEvent.click(undoButton());
    const undone = await screen.findByText("Undone");
    await waitFor(() => expect(document.activeElement).toBe(undone));
    view.unmount();

    resetUndoneAnswers();
    undoAnswer.mockResolvedValueOnce({
      kind: "changed",
      restored: nothing,
      changed: { ...noneChanged, map: [{ object: "filter", layerProjectId: 12 }] },
    });
    undoAnswer.mockResolvedValueOnce({ kind: "undone", restored: nothing });
    show([answer([mapUpdate(), text])]);
    fireEvent.click(undoButton());
    const anyway = await screen.findByRole("button", { name: "Undo anyway" });
    anyway.focus();
    fireEvent.click(anyway);
    const done = await screen.findByText("Undone");
    await waitFor(() => expect(document.activeElement).toBe(done));
  });

  it("closes the row's details when the question takes its place", async () => {
    undoAnswer.mockResolvedValue({
      kind: "changed",
      restored: nothing,
      changed: { ...noneChanged, map: [{ object: "filter", layerProjectId: 12 }] },
    });
    show([answer([mapUpdate(), text])]);
    fireEvent.click(screen.getByRole("button", { name: "Changed the map" }));
    expect(screen.getByText(/^map_update/)).toBeTruthy();
    fireEvent.click(undoButton());
    await screen.findByRole("button", { name: "Undo anyway" });
    expect(screen.queryByText(/^map_update/)).toBeNull();
  });

  it("asks short questions, with the whole sentence in the tooltip", async () => {
    const ada = { id: "u7", firstname: "Ada", lastname: "Lovelace", avatar: null };
    const asks = async (changed: Record<string, unknown>, parts: AssistantMessage["parts"]) => {
      undoAnswer.mockResolvedValueOnce({
        kind: "changed",
        restored: nothing,
        changed: { ...noneChanged, ...changed },
      });
      const view = show([answer(parts)]);
      fireEvent.click(undoButton());
      await screen.findByRole("button", { name: "Undo anyway" });
      const line = screen.getByText(/was changed/, { selector: "p" });
      const result = {
        text: line.textContent,
        tooltip: line.closest("[title]")?.getAttribute("title") ?? "",
      };
      view.unmount();
      resetUndoneAnswers();
      return result;
    };
    const old = await asks(
      { styles: [{ projectId: "p1", layerProjectId: 12, styleId: "st-1", between: true, tooOld: true }] },
      [styleUpdate(), text]
    );
    expect(old.text).toBe("The style was changed many times since.");
    // The sentence says what Undo anyway does: no second hint after it.
    expect(old.tooltip).toBe(
      "The style was changed many times since. Undo anyway restores the whole style as it was before this answer."
    );
    const byAda = await asks(
      { workflows: [{ id: "wf-1", revision: 7, updatedAt: new Date().toISOString(), updatedBy: ada }] },
      [workflowUpdate(), text]
    );
    expect(byAda.text).toBe("The workflow was changed after this answer edited it.");
    expect(byAda.tooltip).toMatch(/changed after this answer edited it \(by Ada Lovelace/);
    expect(byAda.tooltip).toContain("Undo anyway also takes back the changes made since.");
  });

  it("keeps every question within two lines of the dock, in both languages", () => {
    const questions = [
      "assistant_undo_changed",
      "assistant_undo_changed_many_one",
      "assistant_undo_changed_many_other",
      "assistant_undo_changed_between",
      "assistant_undo_unsaved",
      "assistant_undo_changed_style",
      "assistant_undo_changed_style_between",
      "assistant_undo_changed_style_many",
      "assistant_undo_changed_map",
      "assistant_undo_changed_several",
    ] as const;
    for (const texts of [en, de]) {
      for (const key of questions) {
        const question: unknown = (texts as Record<string, unknown>)[key];
        expect(typeof question, key).toBe("string");
        // 90 characters keep a question to two lines of the dock.
        expect((question as string).length, key).toBeLessThanOrEqual(90);
      }
    }
  });

  it("reads Undone, in part after a typed undo that left removed layers out, and after a reload", () => {
    const parts = [mapUpdate("m-1", [removed, { ...hidden, index: 1 }]), text] as AssistantMessage["parts"];
    const earlier = answer(parts, { run_id: "run-1", undoable: true });
    const map = { project_id: "p1", layers: [13], tree: false, groups: false, basemap: false, scene: false };
    const view = show([
      earlier,
      question,
      answer(
        [typed({ status: "undone", run_id: "run-1", map, not_restored: ["layer_removed"] }), text],
        { run_id: "run-2" },
        "a2"
      ),
    ]);
    const row = rowOf("Changed the map, undone");
    expect(within(row).getByText("Undone, in part")).toBeTruthy();
    expect(row.parentElement?.contains(screen.getByText("Removed layers do not come back."))).toBe(true);
    view.unmount();
    // The history says undone, and the answer's steps say a layer was removed.
    show([answer(parts, { run_id: "run-1", undone: true })]);
    expect(within(rowOf("Changed the map, undone")).getByText("Undone, in part")).toBeTruthy();
    expect(screen.getByText("Removed layers do not come back.")).toBeTruthy();
  });

  it("reads Undone, in part after a typed undo that put a style back in part", () => {
    const style = { project_id: "p1", layer_project_id: 12, style_id: "st-1", revision: 4, partial: true };
    show([
      answer([styleUpdate(), text]),
      question,
      answer(
        [typed({ status: "undone", run_id: "run-1", styles: [style] }), text],
        { run_id: "run-2" },
        "a2"
      ),
    ]);
    expect(within(rowOf("Changed the style, undone")).getByText("Undone, in part")).toBeTruthy();
    expect(
      screen.getByText("A part of the style could not be put back because it no longer fits the data.")
    ).toBeTruthy();
  });

  it("reads plain Undone after a full typed undo, with no line under it", () => {
    show([
      answer([styleUpdate(), mapUpdate(), text]),
      question,
      answer([typed({ status: "undone", run_id: "run-1" }), text], { run_id: "run-2" }, "a2"),
    ]);
    const row = rowOf("Changed the map, undone");
    expect(within(row).getByText("Undone")).toBeTruthy();
    expect(screen.queryByText(/could not be put back|do not come back/)).toBeNull();
  });

  it("keeps the action row with the time for an ended answer whose only action was the Undo", () => {
    const failed = {
      type: "data-run-status",
      data: { status: "failed", error: "slow", code: "run_timeout" },
    };
    show([
      answer([styleUpdate(), failed] as AssistantMessage["parts"], {
        run_id: "run-1",
        created_at: new Date().toISOString(),
      }),
    ]);
    expect(document.querySelector("time")).toBeTruthy();
    expect(within(rowOf("Changed the style")).getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("moves focus to the question and to Undone without scrolling the conversation", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      undoAnswer.mockResolvedValueOnce({
        kind: "changed",
        restored: nothing,
        changed: { ...noneChanged, map: [{ object: "filter", layerProjectId: 12 }] },
      });
      undoAnswer.mockResolvedValueOnce({ kind: "undone", restored: nothing });
      show([answer([mapUpdate(), text])]);
      fireEvent.click(undoButton());
      const asked = await screen.findByText("The map was changed after this answer edited it.");
      expect(focus.mock.contexts.at(-1)).toBe(asked);
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
      fireEvent.click(screen.getByRole("button", { name: "Undo anyway" }));
      const done = await screen.findByText("Undone");
      await waitFor(() => expect(focus.mock.contexts.at(-1)).toBe(done));
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    } finally {
      focus.mockRestore();
    }
  });

  it("words the new texts in both languages", () => {
    expect(en.assistant_undone_in_part).toBe("Undone, in part");
    expect(de.assistant_undone_in_part).toBe("Teilweise rückgängig gemacht");
    expect(en.assistant_step_undone).toBe("undone");
    expect(de.assistant_step_undone).toBe("rückgängig gemacht");
    expect(en.assistant_undo_changed_style_many).toBe("The style was changed many times since.");
    expect(de.assistant_undo_changed_style_many).toBe("Der Stil wurde seitdem oft geändert.");
  });
});
