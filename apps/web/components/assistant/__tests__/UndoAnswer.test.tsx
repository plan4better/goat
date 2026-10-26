import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantRequestError } from "@/lib/assistant/errors";

import { DockActionsContext } from "@/components/assistant/DockActions";
import { dockActions } from "@/components/assistant/__tests__/helpers";
import UndoAnswer, { resetUndoneAnswers } from "@/components/assistant/messages/UndoAnswer";

const { undoAnswer, toast } = vi.hoisted(() => ({
  undoAnswer: vi.fn(),
  toast: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/assistant/transport", () => ({ undoAnswer }));
vi.mock("react-toastify", () => ({ toast }));
vi.mock("react-i18next", async () => {
  const { commonI18n } = await import("@/i18n/__tests__/commonI18n");
  const i18n = commonI18n("en");
  const t = i18n.getFixedT("en", "common");
  return { useTranslation: () => ({ t, i18n }) };
});

const actions = dockActions();
const wrapper = ({ children }: { children: ReactNode }) => (
  <DockActionsContext.Provider value={actions}>{children}</DockActionsContext.Provider>
);
const restored = [{ workflowId: "wf-1", projectId: "p1", revision: 6 }];
const ada = { id: "u7", firstname: "Ada", lastname: "Lovelace", avatar: null };

const mount = (undone = false) =>
  render(<UndoAnswer conversationId="c1" runId="r1" workflowIds={["wf-1"]} undone={undone} />, {
    wrapper,
  });
const undoButton = () => screen.getByRole("button", { name: "Undo" });

beforeEach(() => {
  vi.clearAllMocks();
  actions.unsavedWorkflowChanges.mockReturnValue(false);
  resetUndoneAnswers();
});

describe("the Undo of an answer's edits", () => {
  it("writes the workflows back, has the page follow, and turns into Undone", async () => {
    undoAnswer.mockResolvedValue({ kind: "undone", restored });
    mount();
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(undoAnswer).toHaveBeenCalledWith("c1", "r1", false);
    expect(actions.followWorkflowChanges).toHaveBeenCalledWith([
      { workflowId: "wf-1", projectId: "p1", revision: 6 },
    ]);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("asks before it writes over a change made since, and Undo anyway saves on top", async () => {
    undoAnswer.mockResolvedValueOnce({
      kind: "changed",
      restored: [],
      changed: [{ id: "wf-1", revision: 7, updatedAt: new Date().toISOString(), updatedBy: ada }],
    });
    undoAnswer.mockResolvedValueOnce({ kind: "undone", restored });
    mount();
    fireEvent.click(undoButton());
    expect(await screen.findByText(/changed after this answer edited it \(by Ada Lovelace/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo anyway" }));
    await screen.findByText("Undone");
    expect(undoAnswer).toHaveBeenLastCalledWith("c1", "r1", true);
    expect(actions.followWorkflowChanges).toHaveBeenCalledTimes(1);
  });

  it("leaves everything as it is when the person does not undo anyway", async () => {
    undoAnswer.mockResolvedValue({
      kind: "changed",
      restored: [],
      changed: [{ id: "wf-1", revision: null, updatedAt: null, updatedBy: null }],
    });
    mount();
    fireEvent.click(undoButton());
    await screen.findByText("The workflow was changed after this answer edited it.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo anyway" })).toBeNull());
    expect(undoButton()).toBeTruthy();
    expect(undoAnswer).toHaveBeenCalledTimes(1);
  });

  it("names several workflows changed since by their number", async () => {
    undoAnswer.mockResolvedValue({
      kind: "changed",
      restored: [],
      changed: [
        { id: "wf-1", revision: 7, updatedAt: null, updatedBy: null },
        { id: "wf-2", revision: 4, updatedAt: null, updatedBy: null },
      ],
    });
    mount();
    fireEvent.click(undoButton());
    expect(await screen.findByText("2 workflows were changed after this answer edited them.")).toBeTruthy();
  });

  it("shows Undone for an answer undone before, also elsewhere", async () => {
    undoAnswer.mockRejectedValue(new AssistantRequestError(409, "already_undone"));
    const { unmount } = mount(true);
    expect(screen.getByText("Undone")).toBeTruthy();
    unmount();
    mount();
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(toast.info).toHaveBeenCalledWith("These changes were undone already.");
  });

  it("says why when the workflow can no longer be changed, and stays Undo", async () => {
    undoAnswer.mockRejectedValue(new AssistantRequestError(403, "undo_not_allowed"));
    mount();
    fireEvent.click(undoButton());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "You can no longer change this workflow, so its changes cannot be undone."
      )
    );
    expect(undoButton()).toBeTruthy();
    expect(actions.followWorkflowChanges).not.toHaveBeenCalled();
  });

  it("keeps Undone after the dock mounts the answer again", async () => {
    undoAnswer.mockResolvedValue({ kind: "undone", restored });
    const { unmount } = mount();
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    unmount();
    mount();
    expect(screen.getByText("Undone")).toBeTruthy();
  });

  it("asks first when the open editor holds changes of the workflow not saved yet", async () => {
    actions.unsavedWorkflowChanges.mockReturnValue(true);
    undoAnswer.mockResolvedValue({ kind: "undone", restored });
    mount();
    fireEvent.click(undoButton());
    expect(
      await screen.findByText("The workflow has changes in the editor that are not saved yet.")
    ).toBeTruthy();
    expect(actions.unsavedWorkflowChanges).toHaveBeenCalledWith(["wf-1"]);
    expect(undoAnswer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Undo anyway" }));
    await screen.findByText("Undone");
    expect(undoAnswer).toHaveBeenCalledWith("c1", "r1", false);
  });

  it("asks in words of its own about a save between the answer's edits", async () => {
    undoAnswer.mockResolvedValue({
      kind: "changed",
      restored: [],
      changed: [{ id: "wf-1", revision: null, updatedAt: null, updatedBy: null, between: true }],
    });
    mount();
    fireEvent.click(undoButton());
    expect(await screen.findByText("The workflow was changed while this answer edited it.")).toBeTruthy();
  });

  it("stays Undo while another tab's Undo of it is under way", async () => {
    undoAnswer.mockRejectedValue(new AssistantRequestError(409, "undo_in_progress"));
    mount();
    fireEvent.click(undoButton());
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "These changes are being undone in another tab. Try again in a moment."
      )
    );
    expect(screen.queryByText("Undone")).toBeNull();
    expect(undoButton()).toBeTruthy();
  });
});
