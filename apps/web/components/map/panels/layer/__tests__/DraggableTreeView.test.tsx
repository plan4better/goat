import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DraggableTreeView } from "@/components/map/panels/layer/DraggableTreeView";

/** A group with content of its own shows that content instead of its layers. */

// jsdom has no ResizeObserver; the row labels use one to decide on a tooltip
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const items = (groupContent?: React.ReactNode) => [
  {
    id: "group-7",
    parentId: null,
    label: "Versiegelung",
    isGroup: true,
    collapsed: false,
    legendContent: groupContent,
  },
  { id: "layer-1", parentId: "group-7", label: "2015" },
  { id: "layer-2", parentId: "group-7", label: "2018" },
];

describe("DraggableTreeView", () => {
  it("shows a group's layers", () => {
    render(<DraggableTreeView items={items()} onItemsChange={vi.fn()} disableDrag />);

    expect(screen.getByText("2015")).toBeInTheDocument();
    expect(screen.getByText("2018")).toBeInTheDocument();
  });

  it("shows a group's own content in place of its layers", () => {
    render(<DraggableTreeView items={items(<span>switcher</span>)} onItemsChange={vi.fn()} disableDrag />);

    expect(screen.getByText("Versiegelung")).toBeInTheDocument();
    expect(screen.getByText("switcher")).toBeInTheDocument();
    expect(screen.queryByText("2015")).not.toBeInTheDocument();
  });
});
