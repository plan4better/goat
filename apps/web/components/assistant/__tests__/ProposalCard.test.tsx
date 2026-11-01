import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSurfaceOwner,
  hasProposalUndo,
  markOwnerLive,
  registerSurface,
  releaseOwner,
  resetAssistantStore,
} from "@/lib/assistant/store";
import { useAssistantSurface } from "@/lib/assistant/surface";
import type { AssistantSurfaceAdapter, Proposal } from "@/lib/assistant/types";

import { DockActionsContext } from "@/components/assistant/DockActions";
import { dockActions } from "@/components/assistant/__tests__/helpers";
import ProposalCard from "@/components/assistant/messages/ProposalCard";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("react-toastify", () => ({ toast: { error: toastError } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const actions = dockActions();

/** A mounted page: a live owner token registering the adapter, as `useAssistantSurface` does. */
function register(adapter: AssistantSurfaceAdapter) {
  const owner = createSurfaceOwner();
  markOwnerLive(owner);
  const unregister = registerSurface(adapter, owner);
  return { owner, unregister };
}

const filters: Proposal = {
  version: 1,
  kind: "catalog.filters",
  surface: "catalog",
  target: null,
  title: "Radverkehr in Berlin",
  rows: [
    { k: "q", v: "rad" },
    { k: "themes", v: "transportation" },
    { k: "number_matched", v: "3" },
  ],
  payload: {
    q: "rad",
    facets: { themes: ["transportation"] },
    from: null,
    to: null,
    nuts: [],
    sortby: null,
    number_matched: 3,
  },
};

const view = (projectId: string): Proposal => ({
  version: 1,
  kind: "map.view",
  surface: "project.map",
  target: { project_id: projectId, name: "Radnetz" },
  title: "Innenstadt",
  rows: [
    { k: "project", v: "Radnetz" },
    { k: "bbox", v: "13.1, 52.3, 13.8, 52.7" },
  ],
  payload: { project_id: projectId, camera: null, bbox: [13.1, 52.3, 13.8, 52.7], layer_project_id: null },
});

function card(proposal: Proposal, props: { readOnly?: boolean; conversationProjectId?: string | null } = {}) {
  return render(
    <DockActionsContext.Provider value={actions}>
      <ProposalCard
        proposal={proposal}
        partId="m1:1"
        conversationId="c1"
        conversationProjectId={props.conversationProjectId ?? null}
        readOnly={props.readOnly ?? false}
        isLatest
      />
    </DockActionsContext.Provider>
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  vi.clearAllMocks();
});

describe("ProposalCard", () => {
  it("names its target and translates the row keys", () => {
    card(view("p1"));
    expect(screen.getByText("Innenstadt")).toBeTruthy();
    expect(screen.getByText("assistant_proposal_applies_to")).toBeTruthy();
    expect(screen.getByText("assistant_proposal_tag_map_view")).toBeTruthy();
    expect(screen.getByText("assistant_proposal_row_bbox")).toBeTruthy();
    // The project is named in the target line, not repeated as a row.
    expect(screen.queryByText("assistant_proposal_row_project")).toBeNull();
  });

  it("applies on its own page and offers undo", async () => {
    const undo = vi.fn();
    const apply = vi.fn(() => undo);
    register({ surface: "catalog", getContext: () => ({ surface: "catalog" }), apply });
    card(filters);
    fireEvent.click(screen.getByRole("button", { name: "assistant_proposal_apply_page" }));
    await screen.findByText("assistant_proposal_applied");
    expect(apply).toHaveBeenCalledWith(filters);
    fireEvent.click(screen.getByRole("button", { name: "undo" }));
    expect(undo).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "assistant_proposal_apply_page" })).toBeTruthy();
  });

  it("says on its apply button that the page changes only once applied", async () => {
    register({ surface: "catalog", getContext: () => ({ surface: "catalog" }), apply: vi.fn() });
    card(filters);
    fireEvent.mouseOver(screen.getByRole("button", { name: "assistant_proposal_apply_page" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("assistant_proposal_apply_hint");
  });

  it("keeps Undo on the newest applied card of a page only", async () => {
    // The page's own state: each apply returns an undo that restores what was there before it.
    let q = "";
    const apply = vi.fn((proposal: Proposal) => {
      const before = q;
      q = (proposal.payload as { q: string }).q;
      return () => {
        q = before;
      };
    });
    register({ surface: "catalog", getContext: () => ({ surface: "catalog" }), apply });
    const second: Proposal = { ...filters, title: "Busverkehr", payload: { ...filters.payload, q: "bus" } };
    render(
      <DockActionsContext.Provider value={actions}>
        <div data-testid="a">
          <ProposalCard
            proposal={filters}
            partId="m1:1"
            conversationId="c1"
            conversationProjectId={null}
            readOnly={false}
            isLatest={false}
          />
        </div>
        <div data-testid="b">
          <ProposalCard
            proposal={second}
            partId="m2:1"
            conversationId="c1"
            conversationProjectId={null}
            readOnly={false}
            isLatest
          />
        </div>
      </DockActionsContext.Provider>
    );
    const a = within(screen.getByTestId("a"));
    const b = within(screen.getByTestId("b"));
    fireEvent.click(a.getByRole("button", { name: "assistant_proposal_apply_page" }));
    await a.findByRole("button", { name: "undo" });
    fireEvent.click(b.getByRole("button", { name: "assistant_proposal_apply_page" }));
    await b.findByRole("button", { name: "undo" });
    expect(q).toBe("bus");
    expect(a.getByText("assistant_proposal_applied")).toBeTruthy();
    expect(a.queryByRole("button", { name: "undo" })).toBeNull();
    fireEvent.click(b.getByRole("button", { name: "undo" }));
    expect(q).toBe("rad");
    expect(b.getByRole("button", { name: "assistant_proposal_apply_page" })).toBeTruthy();
    expect(a.queryByRole("button", { name: "undo" })).toBeNull();
  });

  it("drops the older Undo of a page even when the newer apply returns none", async () => {
    const apply = vi.fn((proposal: Proposal) =>
      proposal.title === "Busverkehr" ? undefined : () => undefined
    );
    register({ surface: "catalog", getContext: () => ({ surface: "catalog" }), apply });
    const second: Proposal = { ...filters, title: "Busverkehr" };
    render(
      <DockActionsContext.Provider value={actions}>
        <div data-testid="a">
          <ProposalCard
            proposal={filters}
            partId="m1:1"
            conversationId="c1"
            conversationProjectId={null}
            readOnly={false}
            isLatest={false}
          />
        </div>
        <div data-testid="b">
          <ProposalCard
            proposal={second}
            partId="m2:1"
            conversationId="c1"
            conversationProjectId={null}
            readOnly={false}
            isLatest
          />
        </div>
      </DockActionsContext.Provider>
    );
    const a = within(screen.getByTestId("a"));
    const b = within(screen.getByTestId("b"));
    fireEvent.click(a.getByRole("button", { name: "assistant_proposal_apply_page" }));
    await a.findByRole("button", { name: "undo" });
    fireEvent.click(b.getByRole("button", { name: "assistant_proposal_apply_page" }));
    await b.findByText("assistant_proposal_applied");
    expect(a.queryByRole("button", { name: "undo" })).toBeNull();
    expect(b.queryByRole("button", { name: "undo" })).toBeNull();
  });

  it("offers Undo only while the page that applied it is open", async () => {
    const { unregister } = register({
      surface: "catalog",
      getContext: () => ({ surface: "catalog" }),
      apply: () => () => undefined,
    });
    card(filters);
    fireEvent.click(screen.getByRole("button", { name: "assistant_proposal_apply_page" }));
    await screen.findByRole("button", { name: "undo" });
    act(() => unregister());
    expect(screen.queryByRole("button", { name: "undo" })).toBeNull();
    expect(screen.getByText("assistant_proposal_applied")).toBeTruthy();
  });

  it("offers to open the target when this page cannot apply the proposal", async () => {
    const map: AssistantSurfaceAdapter = {
      surface: "project.map",
      project: { id: "p1", name: "Eins" },
      getContext: () => ({ surface: "project.map", project_id: "p1" }),
      apply: vi.fn(),
    };
    register(map);
    const { unmount } = card(view("p2"));
    expect(screen.queryByRole("button", { name: "assistant_proposal_apply_map" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "assistant_proposal_open_in_project" }));
    expect(actions.openInProject).toHaveBeenCalledWith("p2", {
      partId: "m1:1",
      bindConversationId: "c1",
      projectName: "Radnetz",
    });
    unmount();

    // Catalog filters while a project is open: a link to the catalog page.
    card(filters);
    fireEvent.click(screen.getByRole("button", { name: "assistant_proposal_open_in_catalog" }));
    expect(actions.openCatalog).toHaveBeenCalledWith("/catalog?q=rad&themes=transportation");
  });

  it("opens catalog filters in the catalog even when they name a project", () => {
    // Plan 3 sends catalog filters without a target today; a later version naming the open project
    // must still lead to the catalog, never to "Open in project to review".
    register({
      surface: "project.map",
      project: { id: "p2", name: "Radnetz" },
      getContext: () => ({ surface: "project.map", project_id: "p2" }),
      apply: vi.fn(),
    });
    card({ ...filters, target: { project_id: "p2", name: "Radnetz" } } as Proposal);
    expect(screen.queryByRole("button", { name: "assistant_proposal_open_in_project" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "assistant_proposal_open_in_catalog" }));
    expect(actions.openCatalog).toHaveBeenCalledWith("/catalog?q=rad&themes=transportation");
    expect(actions.openInProject).not.toHaveBeenCalled();
  });

  it("never applies from a read-only conversation", () => {
    register({ surface: "catalog", getContext: () => ({ surface: "catalog" }), apply: vi.fn() });
    card(filters, { readOnly: true });
    expect(screen.queryByRole("button", { name: "assistant_proposal_apply_page" })).toBeNull();
    expect(screen.getByRole("button", { name: "assistant_proposal_open_in_catalog" })).toBeTruthy();
  });

  it("can be discarded, and reports a failed apply", async () => {
    register({
      surface: "catalog",
      getContext: () => ({ surface: "catalog" }),
      apply: () => {
        throw new Error("boom");
      },
    });
    const { unmount } = card(filters);
    fireEvent.click(screen.getByRole("button", { name: "assistant_proposal_apply_page" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("assistant_proposal_apply_failed"));
    fireEvent.click(screen.getByRole("button", { name: "discard" }));
    expect(screen.getByText("assistant_proposal_discarded")).toBeTruthy();
    unmount();
  });

  it("hides Undo when the page switched to another mode of the same project", async () => {
    // A project page keeps its owner and undoers across a mode switch: the surface decides.
    const owner = createSurfaceOwner();
    markOwnerLive(owner);
    const map: AssistantSurfaceAdapter = {
      surface: "project.map",
      project: { id: "p1", name: "Eins" },
      getContext: () => ({ surface: "project.map", project_id: "p1" }),
      apply: () => () => undefined,
    };
    registerSurface(map, owner);
    card(view("p1"));
    fireEvent.click(screen.getByRole("button", { name: "assistant_proposal_apply_map" }));
    await screen.findByRole("button", { name: "undo" });
    act(() => {
      registerSurface({ ...map, surface: "project.workflows" }, owner);
    });
    expect(hasProposalUndo("m1:1")).toBe(true);
    expect(screen.queryByRole("button", { name: "undo" })).toBeNull();
    expect(screen.getByText("assistant_proposal_applied")).toBeTruthy();
    act(() => {
      registerSurface(map, owner);
    });
    expect(screen.getByRole("button", { name: "undo" })).toBeTruthy();
  });

  it("hides Undo when the same page now shows another project", async () => {
    const owner = createSurfaceOwner();
    markOwnerLive(owner);
    const map = (id: string): AssistantSurfaceAdapter => ({
      surface: "project.map",
      project: { id, name: id },
      getContext: () => ({ surface: "project.map", project_id: id }),
      apply: () => () => undefined,
    });
    registerSurface(map("p1"), owner);
    card(view("p1"));
    fireEvent.click(screen.getByRole("button", { name: "assistant_proposal_apply_map" }));
    await screen.findByRole("button", { name: "undo" });
    act(() => {
      registerSurface(map("p2"), owner);
    });
    expect(hasProposalUndo("m1:1")).toBe(true);
    expect(screen.queryByRole("button", { name: "undo" })).toBeNull();
    act(() => {
      registerSurface(map("p1"), owner);
    });
    expect(screen.getByRole("button", { name: "undo" })).toBeTruthy();
  });

  it("reports a throwing undo and stays applied without an Undo button", async () => {
    register({
      surface: "catalog",
      getContext: () => ({ surface: "catalog" }),
      apply: () => () => {
        throw new Error("boom");
      },
    });
    card(filters);
    fireEvent.click(screen.getByRole("button", { name: "assistant_proposal_apply_page" }));
    fireEvent.click(await screen.findByRole("button", { name: "undo" }));
    expect(toastError).toHaveBeenCalledWith("assistant_proposal_apply_failed");
    expect(screen.getByText("assistant_proposal_applied")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "undo" })).toBeNull();
    expect(hasProposalUndo("m1:1")).toBe(false);
  });

  it("records no Undo when the page unmounted while the apply was running", async () => {
    let finish: (undo: () => void) => void = () => undefined;
    const { owner } = register({
      surface: "catalog",
      getContext: () => ({ surface: "catalog" }),
      apply: () => new Promise<() => void>((resolve) => (finish = resolve)),
    });
    card(filters);
    fireEvent.click(screen.getByRole("button", { name: "assistant_proposal_apply_page" }));
    act(() => releaseOwner(owner));
    await act(async () => finish(() => undefined));
    await screen.findByText("assistant_proposal_applied");
    expect(hasProposalUndo("m1:1")).toBe(false);
    expect(screen.queryByRole("button", { name: "undo" })).toBeNull();
  });

  it("keeps Undo across a re-registration of the page and drops it when the page unmounts", async () => {
    const undo = vi.fn();
    function Page({ contextKey }: { contextKey: string }) {
      useAssistantSurface({
        surface: "catalog",
        contextKey,
        getContext: () => ({ surface: "catalog" }),
        apply: () => undo,
      });
      return null;
    }
    const page = render(<Page contextKey="a" />);
    card(filters);
    fireEvent.click(screen.getByRole("button", { name: "assistant_proposal_apply_page" }));
    await screen.findByRole("button", { name: "undo" });
    // A changed context registers the adapter again; the mount, and its Undo, stay.
    page.rerender(<Page contextKey="b" />);
    expect(screen.getByRole("button", { name: "undo" })).toBeTruthy();
    page.unmount();
    expect(hasProposalUndo("m1:1")).toBe(false);
    expect(screen.queryByRole("button", { name: "undo" })).toBeNull();
  });

  it("offers a project proposal to apply only in the open project", () => {
    register({
      surface: "project.map",
      project: { id: "p1", name: "Eins" },
      getContext: () => ({ surface: "project.map", project_id: "p1" }),
      apply: vi.fn(),
    });
    card(view("p1"));
    expect(screen.getByRole("button", { name: "assistant_proposal_apply_map" })).toBeTruthy();
  });

  it("does not bind a conversation that already belongs to a project", () => {
    card(view("p2"), { conversationProjectId: "p2", readOnly: true });
    fireEvent.click(screen.getByRole("button", { name: "assistant_proposal_open_in_project" }));
    expect(actions.openInProject).toHaveBeenCalledWith("p2", {
      partId: "m1:1",
      bindConversationId: undefined,
      projectName: "Radnetz",
    });
  });
});
