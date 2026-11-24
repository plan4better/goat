import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import type { AnswerChanges } from "@/lib/assistant/answerChanges";
import { AssistantRequestError } from "@/lib/assistant/errors";
import { type MapBridge, registerMapBridge } from "@/lib/assistant/mapBridge";
import type { MapChange } from "@/lib/assistant/mapEdits";

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
const nothing = { workflows: [], styles: [], map: null, notRestored: [] };
const restored = { ...nothing, workflows: [{ workflowId: "wf-1", projectId: "p1", revision: 6 }] };
const noneChanged = { workflows: [], styles: [], map: [] };
const ada = { id: "u7", firstname: "Ada", lastname: "Lovelace", avatar: null };
const workflowChanges: AnswerChanges = {
  workflows: [
    { workflowId: "wf-1", revision: 5 },
    { workflowId: "wf-1", revision: 6 },
  ],
  styles: [],
  map: [],
  layersRemoved: false,
};
const styleChange = (styleId: string, projectId = "p1") => ({
  projectId,
  layerProjectId: 12,
  styleId,
  revision: 5,
  listChanged: false,
});
const styleChanges: AnswerChanges = {
  workflows: [],
  styles: [styleChange("s1")],
  map: [],
  layersRemoved: false,
};
const mapChange = (projectId = "p1", more: Partial<MapChange> = {}): MapChange => ({
  projectId,
  layers: false,
  state: true,
  groups: false,
  basemap: false,
  scene: false,
  ...more,
});
const mapChanges: AnswerChanges = { workflows: [], styles: [], map: [mapChange()], layersRemoved: false };
const undoneStyle = (styleId: string, more: { removed?: boolean; partial?: boolean } = {}) => ({
  projectId: "p1",
  layerProjectId: 12,
  styleId,
  revision: 6,
  removed: false,
  partial: false,
  ...more,
});
const changedStyle = (styleId: string, more: { between?: boolean; tooOld?: boolean } = {}) => ({
  projectId: "p1",
  layerProjectId: 12,
  styleId,
  between: false,
  tooOld: false,
  ...more,
});
const styleRefused = "A style could not be put back because its earlier settings no longer fit the data.";
const groupInUse = "Groups this answer added stay because they are no longer empty.";
const partly = "Already undone: 1 style, the map. The rest of this answer's changes are still in place.";
const wholeHint = "Undo anyway also takes back the changes made since.";
const settingsHint =
  "Undo anyway puts back the settings this answer changed. Later changes of the same settings are replaced, other later changes stay.";
const mixedHint =
  "Undo anyway also takes back the later changes of the workflows. Of styles and the map, only the settings this answer changed go back.";
const undoneMap = { projectId: "p1", layers: [12], tree: false, groups: false, basemap: true, scene: false };

const mount = (undone = false, changes: AnswerChanges = workflowChanges) =>
  render(<UndoAnswer conversationId="c1" runId="r1" changes={changes} undone={undone} />, {
    wrapper,
  });
const undoButton = () => screen.getByRole("button", { name: "Undo" });
/** The done state's hint: the tooltip's title on the disabled button's wrapper. */
const doneHint = () => screen.getByText("Undone").closest("span[title], [aria-label]")?.getAttribute("title");

let unregister: (() => void) | null = null;
const bridge = (projectId: string, settle: MapBridge["settle"]): MapBridge => ({
  projectId,
  isEditor: true,
  followStyles: vi.fn(async () => undefined),
  settle,
  followMap: vi.fn(async () => undefined),
  applyView: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  actions.unsavedWorkflowChanges.mockReturnValue(false);
  resetUndoneAnswers();
  unregister?.();
  unregister = null;
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
    expect(actions.followMapChange).not.toHaveBeenCalled();
  });

  it("asks before it writes over a change made since, and Undo anyway saves on top", async () => {
    undoAnswer.mockResolvedValueOnce({
      kind: "changed",
      restored: nothing,
      changed: {
        ...noneChanged,
        workflows: [{ id: "wf-1", revision: 7, updatedAt: new Date().toISOString(), updatedBy: ada }],
      },
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
      restored: nothing,
      changed: {
        ...noneChanged,
        workflows: [{ id: "wf-1", revision: null, updatedAt: null, updatedBy: null }],
      },
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
      restored: nothing,
      changed: {
        ...noneChanged,
        workflows: [
          { id: "wf-1", revision: 7, updatedAt: null, updatedBy: null },
          { id: "wf-2", revision: 4, updatedAt: null, updatedBy: null },
        ],
      },
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

  it("says why when the project's content can no longer be changed, and stays Undo", async () => {
    undoAnswer.mockRejectedValue(new AssistantRequestError(403, "undo_not_allowed"));
    mount();
    fireEvent.click(undoButton());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "You cannot change this project's content, so these changes cannot be undone."
      )
    );
    expect(undoButton()).toBeTruthy();
    expect(actions.followWorkflowChanges).not.toHaveBeenCalled();
  });

  it("turns into Undone at once when a typed undo took the answer back, without notes of its own", () => {
    const { rerender } = mount(false, mapChanges);
    expect(undoButton()).toBeTruthy();
    rerender(<UndoAnswer conversationId="c1" runId="r1" changes={mapChanges} undone />);
    expect(screen.getByText("Undone")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(doneHint()).toBe("This answer's changes were undone");
    expect(document.querySelectorAll("p")).toHaveLength(0);
    expect(undoAnswer).not.toHaveBeenCalled();
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
      restored: nothing,
      changed: {
        ...noneChanged,
        workflows: [{ id: "wf-1", revision: null, updatedAt: null, updatedBy: null, between: true }],
      },
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
  it("asks no workflow question for an answer that changed styles only", async () => {
    actions.unsavedWorkflowChanges.mockReturnValue(true);
    undoAnswer.mockResolvedValue({ kind: "undone", restored: { ...nothing, styles: [undoneStyle("s1")] } });
    mount(false, styleChanges);
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(actions.unsavedWorkflowChanges).not.toHaveBeenCalled();
    expect(undoAnswer).toHaveBeenCalledWith("c1", "r1", false);
  });

  it("after undo the restored styles are followed as list changes: the active style or a name may have gone back", async () => {
    undoAnswer.mockResolvedValue({
      kind: "undone",
      restored: {
        ...restored,
        styles: [undoneStyle("s1"), { ...undoneStyle("s2", { removed: true }), revision: null }],
        map: undoneMap,
      },
    });
    mount(false, { ...workflowChanges, styles: [styleChange("s1"), styleChange("s2")] });
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(actions.followWorkflowChanges).toHaveBeenCalledWith(restored.workflows);
    expect(actions.followStyleChanges).toHaveBeenCalledTimes(1);
    expect(actions.followStyleChanges).toHaveBeenCalledWith([
      { projectId: "p1", layerProjectId: 12, styleId: "s1", revision: 6, listChanged: true, removed: false },
      {
        projectId: "p1",
        layerProjectId: 12,
        styleId: "s2",
        revision: null,
        listChanged: true,
        removed: true,
      },
    ]);
  });

  it("follows no styles when none went back", async () => {
    undoAnswer.mockResolvedValue({ kind: "undone", restored });
    mount();
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(actions.followStyleChanges).not.toHaveBeenCalled();
  });

  it("asks with the style's question, the between question and the too-old question", async () => {
    const asks = async (styles: ReturnType<typeof changedStyle>[], question: string, hint = settingsHint) => {
      undoAnswer.mockResolvedValueOnce({
        kind: "changed",
        restored: nothing,
        changed: { ...noneChanged, styles },
      });
      const view = mount(false, styleChanges);
      fireEvent.click(undoButton());
      expect(await screen.findByText(question)).toBeTruthy();
      expect(screen.getByText(hint)).toBeTruthy();
      view.unmount();
    };
    await asks([changedStyle("s1")], "The style was changed after this answer edited it.");
    // A save between the answer's edits goes back with them.
    await asks(
      [changedStyle("s1", { between: true })],
      "The style was changed while this answer edited it.",
      wholeHint
    );
    await asks(
      [changedStyle("s1", { between: true, tooOld: true })],
      "The style was changed many times since. Undo anyway restores the whole style as it was before this answer.",
      // The whole style goes back: later changes are taken back too.
      wholeHint
    );
  });

  it("says what Undo anyway does for the kinds the question names", async () => {
    const hintOf = async (changed: Record<string, unknown>) => {
      undoAnswer.mockResolvedValueOnce({
        kind: "changed",
        restored: nothing,
        changed: { ...noneChanged, ...changed },
      });
      const view = mount(false, { ...workflowChanges, styles: [styleChange("s1")] });
      fireEvent.click(undoButton());
      await screen.findByRole("button", { name: "Undo anyway" });
      const hints = [wholeHint, settingsHint, mixedHint].filter((hint) => screen.queryByText(hint));
      view.unmount();
      return hints;
    };
    const workflow = { id: "wf-1", revision: 7, updatedAt: null, updatedBy: null };
    expect(await hintOf({ workflows: [workflow] })).toEqual([wholeHint]);
    expect(await hintOf({ map: [{ object: "basemap" }] })).toEqual([settingsHint]);
    expect(await hintOf({ styles: [changedStyle("s1")], map: [{ object: "basemap" }] })).toEqual([
      settingsHint,
    ]);
    expect(await hintOf({ workflows: [workflow], styles: [changedStyle("s1")] })).toEqual([mixedHint]);
    expect(await hintOf({ styles: [changedStyle("s1"), changedStyle("s2", { tooOld: true })] })).toEqual([
      wholeHint,
    ]);
    // The scene and the tree go back whole; so does everything beside a style that goes back whole.
    expect(await hintOf({ map: [{ object: "scene" }] })).toEqual([wholeHint]);
    expect(await hintOf({ map: [{ object: "tree" }, { object: "basemap" }] })).toEqual([wholeHint]);
    expect(await hintOf({ workflows: [workflow], styles: [changedStyle("s1", { tooOld: true })] })).toEqual([
      wholeHint,
    ]);
    expect(await hintOf({ workflows: [workflow], map: [{ object: "filter", layerProjectId: 12 }] })).toEqual([
      mixedHint,
    ]);
  });

  it("asks with the map's question when only the map was changed since", async () => {
    undoAnswer.mockResolvedValue({
      kind: "changed",
      restored: nothing,
      changed: { ...noneChanged, map: [{ object: "filter", layerProjectId: 12 }] },
    });
    mount(false, styleChanges);
    fireEvent.click(undoButton());
    expect(await screen.findByText("The map was changed after this answer edited it.")).toBeTruthy();
  });

  it("asks with the several question when a workflow and a style changed since", async () => {
    const asks = async (changed: typeof noneChanged | Record<string, unknown>) => {
      undoAnswer.mockResolvedValueOnce({
        kind: "changed",
        restored: nothing,
        changed: { ...noneChanged, ...changed },
      });
      const view = mount(false, { ...workflowChanges, styles: [styleChange("s1")] });
      fireEvent.click(undoButton());
      expect(
        await screen.findByText("Some of this answer's changes were edited again afterwards.")
      ).toBeTruthy();
      view.unmount();
    };
    await asks({
      workflows: [{ id: "wf-1", revision: 7, updatedAt: null, updatedBy: null }],
      styles: [changedStyle("s1")],
    });
    await asks({ styles: [changedStyle("s1"), changedStyle("s2", { tooOld: true })] });
    await asks({ styles: [changedStyle("s1")], map: [{ object: "basemap" }] });
  });

  it("waits for pending style saves before it calls the route", async () => {
    let saved: () => void = () => undefined;
    const settle = vi.fn(() => new Promise<void>((resolve) => (saved = resolve)));
    unregister = registerMapBridge(bridge("p1", settle));
    undoAnswer.mockResolvedValue({ kind: "undone", restored: { ...nothing, styles: [undoneStyle("s1")] } });
    mount(false, {
      workflows: [],
      styles: [styleChange("s1"), styleChange("s2")],
      map: [],
      layersRemoved: false,
    });
    fireEvent.click(undoButton());
    await waitFor(() => expect(settle).toHaveBeenCalledTimes(1));
    expect(undoAnswer).not.toHaveBeenCalled();
    expect((undoButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(undoButton());
    expect(settle).toHaveBeenCalledTimes(1);
    saved();
    await screen.findByText("Undone");
    expect(undoAnswer).toHaveBeenCalledTimes(1);
  });

  it("waits for no map page when the answer changed no style, nor for one of another project", async () => {
    const settle = vi.fn(async () => undefined);
    unregister = registerMapBridge(bridge("p2", settle));
    undoAnswer.mockResolvedValue({ kind: "undone", restored });
    const view = mount();
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    view.unmount();
    resetUndoneAnswers();
    mount(false, styleChanges);
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(settle).not.toHaveBeenCalled();
  });

  it("undoes a stopped answer whose steps name no change, and the page follows the reply", async () => {
    const settle = vi.fn(async () => undefined);
    unregister = registerMapBridge(bridge("p1", settle));
    undoAnswer.mockResolvedValue({
      kind: "undone",
      restored: { ...restored, styles: [undoneStyle("s1")], map: undoneMap },
    });
    mount(false, { workflows: [], styles: [], map: [], layersRemoved: false });
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    // Not known which project it changed: the open map page's pending saves go first.
    expect(settle).toHaveBeenCalledTimes(1);
    expect(undoAnswer).toHaveBeenCalledWith("c1", "r1", false);
    expect(actions.followWorkflowChanges).toHaveBeenCalledWith(restored.workflows);
    expect(actions.followStyleChanges).toHaveBeenCalledWith([
      { projectId: "p1", layerProjectId: 12, styleId: "s1", revision: 6, listChanged: true, removed: false },
    ]);
    expect(actions.followMapChange).toHaveBeenCalledTimes(1);
    expect(actions.followMapChange.mock.calls[0][0]).toMatchObject({ projectId: "p1", basemap: true });
  });

  it("still undoes when waiting for the style saves fails", async () => {
    unregister = registerMapBridge(
      bridge(
        "p1",
        vi.fn(async () => Promise.reject(new Error("gone")))
      )
    );
    undoAnswer.mockResolvedValue({ kind: "undone", restored: nothing });
    mount(false, styleChanges);
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(undoAnswer).toHaveBeenCalledWith("c1", "r1", false);
  });

  it("the hint no longer names workflows, in both languages", async () => {
    expect(en.assistant_undo_hint).toBe("Undo this answer's changes");
    expect(de.assistant_undo_hint).toBe("Die Änderungen dieser Antwort rückgängig machen");
    expect(en.assistant_undone_hint).toBe("This answer's changes were undone");
    expect(de.assistant_undone_hint).toBe("Die Änderungen dieser Antwort wurden rückgängig gemacht");
    // After a reload nothing was counted: the plain done hint.
    mount(true);
    expect(doneHint()).toBe("This answer's changes were undone");
  });

  it("the done hint counts what went back: 2 styles, the map", async () => {
    undoAnswer.mockResolvedValue({
      kind: "undone",
      restored: { ...nothing, styles: [undoneStyle("s1"), undoneStyle("s2")], map: undoneMap },
    });
    const view = mount(false, styleChanges);
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(doneHint()).toBe("This answer's changes were undone: 2 styles, the map");
    // Mounted again in this tab, it keeps what it counted.
    view.unmount();
    mount(false, styleChanges);
    expect(doneHint()).toBe("This answer's changes were undone: 2 styles, the map");
  });

  it("counts what went back before and after Undo anyway, each once", async () => {
    undoAnswer.mockResolvedValueOnce({
      kind: "changed",
      restored: { ...restored, styles: [undoneStyle("s1")] },
      changed: { ...noneChanged, styles: [changedStyle("s2")] },
    });
    undoAnswer.mockResolvedValueOnce({
      kind: "undone",
      restored: { ...nothing, styles: [undoneStyle("s2")] },
    });
    mount(false, { ...workflowChanges, styles: [styleChange("s1"), styleChange("s2")] });
    fireEvent.click(undoButton());
    await screen.findByText("The style was changed after this answer edited it.");
    fireEvent.click(screen.getByRole("button", { name: "Undo anyway" }));
    await screen.findByText("Undone");
    expect(doneHint()).toBe("This answer's changes were undone: 1 workflow, 2 styles");
  });

  it("drops the refused style's line when a later press finds the answer undone already", async () => {
    undoAnswer.mockResolvedValueOnce({ kind: "undone", restored: { ...nothing, notRestored: ["style"] } });
    undoAnswer.mockRejectedValueOnce(new AssistantRequestError(409, "already_undone"));
    mount(false, styleChanges);
    fireEvent.click(undoButton());
    await screen.findByText(styleRefused);
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(screen.queryByText(styleRefused)).toBeNull();
  });

  it("refreshes the page when the answer turned out undone already", async () => {
    undoAnswer.mockRejectedValue(new AssistantRequestError(409, "already_undone"));
    mount(false, {
      workflows: [{ workflowId: "wf-1", revision: 5 }],
      styles: [styleChange("s1"), { ...styleChange("s2", "p2"), listChanged: true }],
      map: [
        mapChange("p1"),
        mapChange("p1", { basemap: true, state: false }),
        mapChange("p2", { scene: true }),
      ],
      layersRemoved: false,
    });
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    // The refusal names nothing: what the answer changed is read again.
    expect(actions.followWorkflowChanges).toHaveBeenCalledWith([{ workflowId: "wf-1", revision: null }]);
    expect(actions.followStyleChanges).toHaveBeenCalledWith([
      { ...styleChange("s1"), revision: null, listChanged: true },
      { ...styleChange("s2", "p2"), revision: null, listChanged: true },
    ]);
    expect(actions.followMapChange).toHaveBeenCalledTimes(2);
    expect(actions.followMapChange).toHaveBeenCalledWith(mapChange("p1", { basemap: true }));
    expect(actions.followMapChange).toHaveBeenCalledWith(mapChange("p2", { state: true, scene: true }));
  });

  it("shows the plain done hint when the answer turned out undone already", async () => {
    undoAnswer.mockRejectedValue(new AssistantRequestError(409, "already_undone"));
    mount(false, styleChanges);
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(doneHint()).toBe("This answer's changes were undone");
  });

  it("a partly restored style says that a part could not be put back", async () => {
    undoAnswer.mockResolvedValue({
      kind: "undone",
      restored: { ...nothing, styles: [undoneStyle("s1", { partial: true })] },
    });
    mount(false, styleChanges);
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(
      screen.getByText("A part of the style could not be put back because it no longer fits the data.")
    ).toBeTruthy();
    expect(screen.queryByText("Removed layers do not come back.")).toBeNull();
  });

  it("says that removed layers do not come back", async () => {
    undoAnswer.mockResolvedValue({
      kind: "undone",
      restored: { ...nothing, map: undoneMap, notRestored: ["layer_removed"] },
    });
    mount(false, styleChanges);
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(screen.getByText("Removed layers do not come back.")).toBeTruthy();
    expect(screen.queryByText("A part of the map could not be put back.")).toBeNull();
  });

  it("says that a part of the map could not be put back, and keeps it over a second press", async () => {
    undoAnswer.mockResolvedValueOnce({
      kind: "changed",
      restored: { ...nothing, map: undoneMap, notRestored: ["map_refused"] },
      changed: { ...noneChanged, styles: [changedStyle("s1")] },
    });
    undoAnswer.mockResolvedValueOnce({
      kind: "undone",
      restored: { ...nothing, styles: [undoneStyle("s1")] },
    });
    mount(false, { ...mapChanges, styles: [styleChange("s1")] });
    fireEvent.click(undoButton());
    await screen.findByText("The style was changed after this answer edited it.");
    fireEvent.click(screen.getByRole("button", { name: "Undo anyway" }));
    await screen.findByText("Undone");
    expect(screen.getByText("A part of the map could not be put back.")).toBeTruthy();
    expect(screen.queryByText("Removed layers do not come back.")).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(doneHint()).toBe("This answer's changes were undone: 1 style, the map");
  });

  it("words the refused Undo and the map's line for every kind of change, in both languages", () => {
    expect(en.assistant_error_undo_not_allowed).toBe(
      "You cannot change this project's content, so these changes cannot be undone."
    );
    expect(de.assistant_error_undo_not_allowed).toBe(
      "Sie können die Inhalte dieses Projekts nicht ändern, daher lassen sich diese Änderungen nicht rückgängig machen."
    );
    expect(en.assistant_undone_map_refused).toBe("A part of the map could not be put back.");
    expect(de.assistant_undone_map_refused).toBe("Ein Teil der Karte konnte nicht wiederhergestellt werden.");
  });

  it("stays Undo and says so when core stored nothing of a style's restore", async () => {
    undoAnswer.mockResolvedValueOnce({
      kind: "undone",
      restored: { ...restored, notRestored: ["style"] },
    });
    mount(false, { ...workflowChanges, styles: [styleChange("s1")] });
    fireEvent.click(undoButton());
    expect(await screen.findByText(styleRefused)).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
    expect(actions.followWorkflowChanges).toHaveBeenCalledWith(restored.workflows);
    expect(screen.queryByText("Undone")).toBeNull();
    expect(undoButton()).toBeTruthy();
    // A second press that puts the style back drops the line.
    undoAnswer.mockResolvedValueOnce({
      kind: "undone",
      restored: { ...nothing, styles: [undoneStyle("s1")] },
    });
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(screen.queryByText(styleRefused)).toBeNull();
  });

  it("drops the refused style's line once a typed undo took the answer back", async () => {
    undoAnswer.mockResolvedValueOnce({
      kind: "undone",
      restored: { ...restored, notRestored: ["style"] },
    });
    const changes = { ...workflowChanges, styles: [styleChange("s1")] };
    const { rerender } = mount(false, changes);
    fireEvent.click(undoButton());
    expect(await screen.findByText(styleRefused)).toBeTruthy();
    rerender(<UndoAnswer conversationId="c1" runId="r1" changes={changes} undone />);
    expect(screen.getByText("Undone")).toBeTruthy();
    expect(screen.queryByText(styleRefused)).toBeNull();
  });

  it("says what already went back when the rest was changed since, also after the question closes", async () => {
    undoAnswer.mockResolvedValue({
      kind: "changed",
      restored: { ...nothing, styles: [undoneStyle("s1")], map: undoneMap },
      changed: { ...noneChanged, styles: [changedStyle("s2")] },
    });
    mount(false, { ...mapChanges, styles: [styleChange("s1"), styleChange("s2")] });
    fireEvent.click(undoButton());
    await screen.findByText("The style was changed after this answer edited it.");
    expect(screen.getByText(partly)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // The popover fades out: its copy of the line goes once it is closed.
    await waitFor(() => expect(screen.getAllByText(partly)).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Undo anyway" })).toBeNull();
    expect(undoButton()).toBeTruthy();
  });

  it("asks without that line when nothing went back yet", async () => {
    undoAnswer.mockResolvedValue({
      kind: "changed",
      restored: nothing,
      changed: { ...noneChanged, styles: [changedStyle("s1")] },
    });
    mount(false, styleChanges);
    fireEvent.click(undoButton());
    await screen.findByText("The style was changed after this answer edited it.");
    expect(screen.queryByText(/^Already undone/)).toBeNull();
  });

  it("words the new lines in both languages", () => {
    expect(en.assistant_undone_style_refused).toBe(styleRefused);
    expect(de.assistant_undone_style_refused).toBe(
      "Ein Stil konnte nicht wiederhergestellt werden, weil seine früheren Einstellungen nicht mehr zu den Daten passen."
    );
    expect(en.assistant_undone_group_in_use).toBe(groupInUse);
    expect(de.assistant_undone_group_in_use).toBe(
      "Gruppen, die diese Antwort hinzugefügt hat, bleiben, weil sie nicht mehr leer sind."
    );
    expect(de.assistant_undo_partly).toBe(
      "Bereits rückgängig gemacht: {{parts}}. Die übrigen Änderungen dieser Antwort bestehen weiter."
    );
    expect(de.assistant_undo_anyway_hint_settings).toBe(
      "Trotzdem rückgängig machen stellt die Einstellungen wieder her, die diese Antwort geändert hat. Spätere Änderungen derselben Einstellungen werden ersetzt, andere spätere Änderungen bleiben."
    );
    expect(de.assistant_undo_anyway_hint_mixed).toBe(
      "Trotzdem rückgängig machen nimmt bei Workflows auch die Änderungen seitdem zurück. Bei Stilen und der Karte werden nur die Einstellungen wiederhergestellt, die diese Antwort geändert hat."
    );
  });

  it("an answer that hid a layer shows Undo and follows the restored map", async () => {
    const settle = vi.fn(async () => undefined);
    unregister = registerMapBridge(bridge("p1", settle));
    undoAnswer.mockImplementation(async () => {
      expect(settle).toHaveBeenCalledTimes(1);
      return { kind: "undone", restored: { ...nothing, map: { ...undoneMap, basemap: false } } };
    });
    mount(false, mapChanges);
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(undoAnswer).toHaveBeenCalledWith("c1", "r1", false);
    expect(actions.unsavedWorkflowChanges).not.toHaveBeenCalled();
    expect(actions.followMapChange).toHaveBeenCalledTimes(1);
    // A layer's entry does not say what of it went back: its row and its map state are read again.
    expect(actions.followMapChange).toHaveBeenCalledWith(mapChange("p1", { layers: true }));
    expect(actions.followStyleChanges).not.toHaveBeenCalled();
    expect(doneHint()).toBe("This answer's changes were undone: the map");
  });

  it("follows the basemap, tree and groups a map undo names", async () => {
    undoAnswer.mockResolvedValue({
      kind: "undone",
      restored: {
        ...nothing,
        map: { projectId: "p1", layers: [], tree: true, groups: true, basemap: true, scene: true },
      },
    });
    mount(false, mapChanges);
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(actions.followMapChange).toHaveBeenCalledWith(
      mapChange("p1", { layers: true, groups: true, basemap: true, scene: true })
    );
  });

  it("an answer with a removed layer says that removed layers do not come back", async () => {
    undoAnswer.mockResolvedValue({
      kind: "undone",
      restored: {
        ...nothing,
        map: { ...undoneMap, layers: [], tree: true, groups: true, basemap: false },
        notRestored: ["layer_removed", "group_in_use"],
      },
    });
    mount(false, { ...mapChanges, map: [mapChange("p1", { layers: true, groups: true })] });
    fireEvent.click(undoButton());
    await screen.findByText("Undone");
    expect(actions.followMapChange).toHaveBeenCalledWith(mapChange("p1", { layers: true, groups: true }));
    expect(screen.getByText("Removed layers do not come back.")).toBeTruthy();
    // A group that is no longer empty stays, and a line of its own says so.
    expect(screen.getByText(groupInUse)).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
    expect(doneHint()).toBe("This answer's changes were undone: the map");
  });

  it("a map changed since asks with the map's question and Undo anyway sends force", async () => {
    const settle = vi.fn(async () => undefined);
    unregister = registerMapBridge(bridge("p1", settle));
    undoAnswer.mockResolvedValueOnce({
      kind: "changed",
      restored: nothing,
      changed: { ...noneChanged, map: [{ object: "filter", layerProjectId: 12 }] },
    });
    undoAnswer.mockResolvedValueOnce({
      kind: "undone",
      restored: { ...nothing, map: { ...undoneMap, basemap: false } },
    });
    mount(false, mapChanges);
    fireEvent.click(undoButton());
    expect(await screen.findByText("The map was changed after this answer edited it.")).toBeTruthy();
    expect(actions.followMapChange).not.toHaveBeenCalled();
    expect(undoAnswer).toHaveBeenLastCalledWith("c1", "r1", false);
    fireEvent.click(screen.getByRole("button", { name: "Undo anyway" }));
    await screen.findByText("Undone");
    expect(undoAnswer).toHaveBeenLastCalledWith("c1", "r1", true);
    // The pending saves go out before each call of the route.
    expect(settle).toHaveBeenCalledTimes(2);
    expect(actions.followMapChange).toHaveBeenCalledTimes(1);
    expect(actions.followMapChange).toHaveBeenCalledWith(mapChange("p1", { layers: true }));
  });

  it("follows what of the map went back before it asks", async () => {
    undoAnswer.mockResolvedValue({
      kind: "changed",
      restored: { ...nothing, map: { ...undoneMap, layers: [] } },
      changed: { ...noneChanged, map: [{ object: "filter", layerProjectId: 12 }] },
    });
    mount(false, mapChanges);
    fireEvent.click(undoButton());
    await screen.findByText("The map was changed after this answer edited it.");
    expect(actions.followMapChange).toHaveBeenCalledWith(mapChange("p1", { state: false, basemap: true }));
  });

  it("waits once per project for pending saves when the answer changed styles and the map", async () => {
    const changes: AnswerChanges = {
      workflows: [],
      styles: [styleChange("s1")],
      map: [mapChange("p1"), mapChange("p1", { basemap: true }), mapChange("p2")],
      layersRemoved: false,
    };
    undoAnswer.mockResolvedValue({ kind: "undone", restored: nothing });
    for (const projectId of ["p1", "p2"]) {
      const settle = vi.fn(async () => undefined);
      unregister?.();
      unregister = registerMapBridge(bridge(projectId, settle));
      resetUndoneAnswers();
      const view = mount(false, changes);
      fireEvent.click(undoButton());
      await screen.findByText("Undone");
      // p1 has a style and two map steps, p2 only a map step.
      expect(settle).toHaveBeenCalledTimes(1);
      view.unmount();
    }
    expect(undoAnswer).toHaveBeenCalledTimes(2);
  });
});
