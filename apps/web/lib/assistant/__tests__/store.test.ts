import { beforeEach, describe, expect, it } from "vitest";

import {
  addPendingRun,
  claimDock,
  clearFirstMessage,
  createSurfaceOwner,
  dropProposalUndoers,
  getActiveSurface,
  getActiveSurfaceOwner,
  getDockState,
  hasProposalUndo,
  markOwnerLive,
  peekFirstMessage,
  registerSurface,
  releaseOwner,
  resetAssistantStore,
  setDockState,
  setFirstMessage,
  setProposalUndo,
} from "@/lib/assistant/store";
import type { AssistantSurfaceAdapter } from "@/lib/assistant/types";

const adapter = (surface: AssistantSurfaceAdapter["surface"]): AssistantSurfaceAdapter => ({
  surface,
  getContext: () => ({ surface: "catalog" }),
});

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
});

describe("assistant store", () => {
  it("keeps the open conversation across a page reload, but not whether AI is enabled", () => {
    setDockState({ open: true, conversationId: "c1", enabled: true });
    expect(JSON.parse(window.sessionStorage.getItem("goat:assistant-dock") ?? "{}")).toEqual({
      open: true,
      expanded: false,
      conversationId: "c1",
      pending: [],
      owner: null,
    });
    resetAssistantStore();
    expect(getDockState()).toMatchObject({ open: true, conversationId: "c1", enabled: false });
  });

  it("drops another user's conversation when a different user signs in", () => {
    setDockState({
      open: true,
      conversationId: "c1",
      pending: [{ conversationId: "c1", title: "x", since: 1 }],
    });
    claimDock("user-a");
    expect(getDockState()).toMatchObject({ owner: "user-a", conversationId: "c1" });
    // The same tab, after a sign-out and a sign-in as someone else.
    resetAssistantStore();
    claimDock("user-b");
    expect(getDockState()).toMatchObject({ owner: "user-b", conversationId: null, pending: [], open: true });
    // The same user again keeps everything.
    setDockState({ conversationId: "c2" });
    claimDock("user-b");
    expect(getDockState().conversationId).toBe("c2");
  });

  it("keeps a refusal for used-up AI credits for this tab and its user only", () => {
    claimDock("user-a");
    setDockState({ aiCreditsUsedUp: { resetsOn: "2026-12-01T00:00:00", onTrial: false } });
    expect(getDockState().aiCreditsUsedUp).toEqual({ resetsOn: "2026-12-01T00:00:00", onTrial: false });
    // Not stored: a reload asks the balance again.
    expect(window.sessionStorage.getItem("goat:assistant-dock")).not.toContain("aiCreditsUsedUp");
    resetAssistantStore();
    expect(getDockState().aiCreditsUsedUp).toBeNull();
    // Another user in the same tab is not told the previous organization's state.
    setDockState({ aiCreditsUsedUp: { resetsOn: null, onTrial: true } });
    claimDock("user-b");
    expect(getDockState().aiCreditsUsedUp).toBeNull();
  });

  it("starts closed when the stored state cannot be read", () => {
    window.sessionStorage.setItem("goat:assistant-dock", "{not json");
    resetAssistantStore();
    expect(getDockState()).toMatchObject({ open: false, conversationId: null });
  });

  it("lets the newest surface win and ignores a stale unregister", () => {
    const unregisterCatalog = registerSurface(adapter("catalog"));
    const unregisterMap = registerSurface(adapter("project.map"));
    unregisterCatalog();
    expect(getActiveSurface()?.surface).toBe("project.map");
    unregisterMap();
    expect(getActiveSurface()).toBeNull();
  });

  it("hands the first message to its own conversation until it is cleared", () => {
    setFirstMessage({ conversationId: "c1", text: "hi", context: null });
    expect(peekFirstMessage("c2")).toBeNull();
    expect(peekFirstMessage("c1")).toEqual({ conversationId: "c1", text: "hi", context: null });
    clearFirstMessage("c1");
    expect(peekFirstMessage("c1")).toBeNull();
  });

  it("keeps an undo across a re-registration of its page and drops it with the owner", () => {
    const owner = createSurfaceOwner();
    markOwnerLive(owner);
    const first = adapter("catalog");
    registerSurface(first, owner)();
    setProposalUndo("m1:1", () => undefined, owner);
    const unregister = registerSurface(adapter("catalog"), owner);
    expect(getActiveSurfaceOwner()).toBe(owner);
    unregister();
    expect(hasProposalUndo("m1:1")).toBe(true);
    dropProposalUndoers(createSurfaceOwner());
    expect(hasProposalUndo("m1:1")).toBe(true);
    releaseOwner(owner);
    expect(hasProposalUndo("m1:1")).toBe(false);
  });

  it("keeps only the newest undo of an owner", () => {
    // An older undo would restore the page from before the newer apply.
    const owner = createSurfaceOwner();
    const other = createSurfaceOwner();
    markOwnerLive(owner);
    markOwnerLive(other);
    setProposalUndo("m1:1", () => undefined, owner);
    setProposalUndo("m9:1", () => undefined, other);
    setProposalUndo("m2:1", () => undefined, owner);
    expect(hasProposalUndo("m1:1")).toBe(false);
    expect(hasProposalUndo("m2:1")).toBe(true);
    expect(hasProposalUndo("m9:1")).toBe(true);
    releaseOwner(owner);
    releaseOwner(other);
  });

  it("ignores an undo recorded for an owner that is gone or was never mounted", () => {
    const owner = createSurfaceOwner();
    setProposalUndo("m1:1", () => undefined, owner);
    expect(hasProposalUndo("m1:1")).toBe(false);
    markOwnerLive(owner);
    releaseOwner(owner);
    setProposalUndo("m1:1", () => undefined, owner);
    expect(hasProposalUndo("m1:1")).toBe(false);
  });

  it("tracks one pending run per conversation", () => {
    addPendingRun({ conversationId: "c1", title: "a", since: 1 });
    addPendingRun({ conversationId: "c1", title: "b", since: 2 });
    expect(getDockState().pending).toEqual([{ conversationId: "c1", title: "b", since: 2 }]);
  });

  it("keeps the pending runs across a page reload, so their end is still announced", () => {
    addPendingRun({ conversationId: "c1", title: "Radwege", since: 5, knownAnswerId: "a1" });
    addPendingRun({ conversationId: "c2", title: "Grün", since: 6, knownAnswerId: null });
    resetAssistantStore();
    expect(getDockState().pending).toEqual([
      { conversationId: "c1", title: "Radwege", since: 5, knownAnswerId: "a1" },
      { conversationId: "c2", title: "Grün", since: 6, knownAnswerId: null },
    ]);
  });

  it("drops stored pending runs it cannot read", () => {
    window.sessionStorage.setItem(
      "goat:assistant-dock",
      JSON.stringify({
        open: true,
        pending: [
          { conversationId: "c1", title: "ok", since: 1 },
          { conversationId: 7, title: "x", since: 1 },
          { conversationId: "c3", title: "x", since: "soon" },
          { conversationId: "c4", title: "x", since: 1, knownAnswerId: 3 },
          null,
        ],
      })
    );
    resetAssistantStore();
    expect(getDockState().pending).toEqual([
      { conversationId: "c1", title: "ok", since: 1, knownAnswerId: null },
    ]);
    window.sessionStorage.setItem("goat:assistant-dock", JSON.stringify({ pending: "c1" }));
    resetAssistantStore();
    expect(getDockState().pending).toEqual([]);
  });
});
