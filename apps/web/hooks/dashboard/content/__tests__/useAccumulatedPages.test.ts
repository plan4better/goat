import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ContentItem, ContentPage } from "@/lib/validations/content";

import { useAccumulatedPages } from "@/hooks/dashboard/content/useAccumulatedPages";

const item = (id: string, overrides: Partial<ContentItem> = {}): ContentItem => ({
  type: "layer",
  id,
  name: `item-${id}`,
  space_id: "space-1",
  updated_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  my_role: "owner",
  shared_with: null,
  is_shortcut: false,
  is_public: false,
  restricted: false,
  restricted_inherited: false,
  ...overrides,
});

const page = (items: ContentItem[], total = items.length): ContentPage => ({ items, total, page: 1, size: 20 });

describe("useAccumulatedPages", () => {
  it("lists the fetched page once it arrives", () => {
    const { result, rerender } = renderHook(
      ({ fetched }: { fetched?: ContentPage }) => useAccumulatedPages(fetched, 1, "space-1"),
      { initialProps: {} }
    );
    expect(result.current.loaded).toBe(false);

    rerender({ fetched: page([item("a"), item("b")]) });
    expect(result.current.loaded).toBe(true);
    expect(result.current.items.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("keeps the stored rows when a revalidation returns an equal page", () => {
    const first = page([item("a")]);
    const { result, rerender } = renderHook(
      ({ fetched }: { fetched: ContentPage }) => useAccumulatedPages(fetched, 1, "space-1"),
      { initialProps: { fetched: first } }
    );
    const before = result.current.items;

    rerender({ fetched: page([item("a")]) });
    expect(result.current.items).toBe(before);
  });

  it("picks up a share that did not touch updated_at", () => {
    const { result, rerender } = renderHook(
      ({ fetched }: { fetched: ContentPage }) => useAccumulatedPages(fetched, 1, "space-1"),
      { initialProps: { fetched: page([item("a")]) } }
    );
    expect(result.current.items[0].shared_with).toBeNull();

    const shared = item("a", {
      shared_with: { teams: [{ id: "team-1", name: "Admins", role: "layer-viewer" }], organizations: [], users: [] },
    });
    rerender({ fetched: page([shared]) });
    expect(result.current.items[0].shared_with?.teams).toHaveLength(1);
  });

  it("picks up a changed audience flag on an otherwise unchanged row", () => {
    const { result, rerender } = renderHook(
      ({ fetched }: { fetched: ContentPage }) => useAccumulatedPages(fetched, 1, "space-1"),
      { initialProps: { fetched: page([item("a")]) } }
    );

    rerender({ fetched: page([item("a", { is_public: true })]) });
    expect(result.current.items[0].is_public).toBe(true);
  });
});
