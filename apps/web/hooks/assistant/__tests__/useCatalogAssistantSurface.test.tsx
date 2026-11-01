import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getActiveSurface, hasProposalUndo, resetAssistantStore } from "@/lib/assistant/store";
import type { Proposal } from "@/lib/assistant/types";
import type { CatalogAggregation } from "@/lib/validations/catalog";

import { useCatalogAssistantSurface } from "@/hooks/assistant/useCatalogAssistantSurface";
import { useCatalogSearchState } from "@/hooks/catalog/useCatalogSearchState";

import { DockActionsContext } from "@/components/assistant/DockActions";
import { dockActions } from "@/components/assistant/__tests__/helpers";
import ProposalCard from "@/components/assistant/messages/ProposalCard";

vi.mock("react-toastify", () => ({ toast: { error: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const aggregations = [
  { name: "category_count", "goat:filter_param": "themes" },
  { name: "license_count", "goat:filter_param": "license" },
] as unknown as CatalogAggregation[];

function usePage() {
  const search = useCatalogSearchState({ aggregations });
  useCatalogAssistantSurface(search);
  return search;
}

const proposal: Proposal = {
  version: 1,
  kind: "catalog.filters",
  surface: "catalog",
  target: null,
  title: "Radverkehr",
  rows: [{ k: "q", v: "rad" }],
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

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
});

describe("useCatalogAssistantSurface", () => {
  it("publishes the page's search as context", () => {
    renderHook(usePage, {
      wrapper: withNuqsTestingAdapter({
        searchParams: "?q=rad&themes=transportation&nuts=DED&sortby=-updated",
      }),
    });
    expect(getActiveSurface()?.getContext()).toEqual({
      surface: "catalog",
      q: "rad",
      facets: { themes: ["transportation"] },
      nuts: ["DED"],
      sortby: "-updated",
    });
  });

  it("registers once for an unchanged context and again when the search changes", () => {
    const { result, rerender } = renderHook(usePage, {
      wrapper: withNuqsTestingAdapter({ searchParams: "?q=rad" }),
    });
    const first = getActiveSurface();
    rerender();
    expect(getActiveSurface()).toBe(first);
    act(() => {
      void result.current.setQ("bus");
    });
    expect(getActiveSurface()).not.toBe(first);
    expect(getActiveSurface()?.getContext()).toEqual({ surface: "catalog", q: "bus" });
  });

  it("applies a proposal to the page's own state and undoes it", async () => {
    const { result } = renderHook(usePage, {
      wrapper: withNuqsTestingAdapter({ searchParams: "?q=alt&license=CC-BY-4.0&page=3" }),
    });
    let undo: unknown;
    await act(async () => {
      undo = await getActiveSurface()?.apply?.(proposal);
    });
    await waitFor(() => expect(result.current.state.q).toBe("rad"));
    expect(result.current.facetSelections).toEqual({ themes: ["transportation"] });
    expect(result.current.page).toBe(1);
    act(() => {
      (undo as () => void)();
    });
    await waitFor(() => expect(result.current.state.q).toBe("alt"));
    expect(result.current.facetSelections).toEqual({ license: ["CC-BY-4.0"] });
  });

  it("restores a buffered point and a drawn area on undo", async () => {
    const { result } = renderHook(usePage, {
      wrapper: withNuqsTestingAdapter({ searchParams: "?q=alt&pt=13,52,3" }),
    });
    let undo: unknown;
    await act(async () => {
      undo = await getActiveSurface()?.apply?.(proposal);
    });
    await waitFor(() => expect(result.current.state.q).toBe("rad"));
    expect(result.current.state.pt).toBeNull();
    expect(result.current.state.poly).toBeNull();
    act(() => {
      (undo as () => void)();
    });
    await waitFor(() => expect(result.current.state.pt).toBe("13,52,3"));
    expect(result.current.state.poly).toBeNull();
    expect(result.current.state.q).toBe("alt");
  });

  it("restores a drawn area on undo", async () => {
    const poly = "13 52;14 52;14 53;13 52";
    const { result } = renderHook(usePage, {
      wrapper: withNuqsTestingAdapter({ searchParams: `?poly=${encodeURIComponent(poly)}` }),
    });
    let undo: unknown;
    await act(async () => {
      undo = await getActiveSurface()?.apply?.(proposal);
    });
    await waitFor(() => expect(result.current.state.poly).toBeNull());
    act(() => {
      (undo as () => void)();
    });
    await waitFor(() => expect(result.current.state.poly).toBe(poly));
    expect(result.current.state.pt).toBeNull();
  });

  it("keeps Undo on the card after the applied search re-registers the page, and drops it on unmount", async () => {
    const actions = dockActions();
    function Harness() {
      usePage();
      return (
        <DockActionsContext.Provider value={actions}>
          <ProposalCard
            proposal={proposal}
            partId="m1:1"
            conversationId="c1"
            conversationProjectId={null}
            readOnly={false}
            isLatest
          />
        </DockActionsContext.Provider>
      );
    }
    const wrapper = withNuqsTestingAdapter({ searchParams: "?q=alt&license=CC-BY-4.0" });
    const { unmount } = render(<Harness />, { wrapper });
    const before = getActiveSurface();
    fireEvent.click(screen.getByText("assistant_proposal_apply_page"));
    // Applying changes the search, so the page registers again with the new context.
    await waitFor(() => expect(getActiveSurface()).not.toBe(before));
    expect(getActiveSurface()?.getContext()).toMatchObject({
      q: "rad",
      facets: { themes: ["transportation"] },
    });
    await screen.findByText("assistant_proposal_applied");
    expect(hasProposalUndo("m1:1")).toBe(true);
    expect(screen.getByText("undo")).toBeTruthy();

    fireEvent.click(screen.getByText("undo"));
    await waitFor(() => expect(getActiveSurface()?.getContext()).toMatchObject({ q: "alt" }));
    expect(getActiveSurface()?.getContext()).toMatchObject({ facets: { license: ["CC-BY-4.0"] } });
    expect(screen.queryByText("assistant_proposal_applied")).toBeNull();

    fireEvent.click(screen.getByText("assistant_proposal_apply_page"));
    await screen.findByText("undo");
    unmount();
    expect(hasProposalUndo("m1:1")).toBe(false);
  });
});
