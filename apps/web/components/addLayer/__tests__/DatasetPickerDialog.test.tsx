import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ContentItem } from "@/lib/validations/content";

import DatasetPickerDialog from "@/components/addLayer/DatasetPickerDialog";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const items = [
  {
    type: "layer",
    id: "l1",
    name: "roads",
    space_id: "p1",
    folder_id: null,
    updated_at: "2026-01-01",
    is_shortcut: false,
    layer_type: "feature",
    feature_layer_geometry_type: "line",
  },
] as unknown as ContentItem[];

vi.mock("@/components/addLayer/DatasetPickerBody", () => ({
  default: (props: { picked: ContentItem | null; onPickedChange: (item: ContentItem | null) => void }) => (
    <button onClick={() => props.onPickedChange(props.picked ? null : items[0])}>pick-roads</button>
  ),
}));

describe("DatasetPickerDialog", () => {
  it("enables Use dataset only once something is picked and hands the item back", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<DatasetPickerDialog open onClose={onClose} onPick={onPick} />);
    // Read off the DOM property rather than a matcher: the repo's ESLint
    // setup reads jest-dom's `toBeDisabled`/`toBeEnabled` as Playwright's
    // (async) matchers of the same name.
    const use = screen.getByRole("button", { name: "use_dataset" }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.click(screen.getByText("pick-roads"));
    expect(use.disabled).toBe(false);
    fireEvent.click(use);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "l1", name: "roads" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes without picking anything", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<DatasetPickerDialog open onClose={onClose} onPick={onPick} />);
    fireEvent.click(screen.getByText("pick-roads"));
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps Use dataset off for an item the host cannot take, and says why", () => {
    const onPick = vi.fn();
    render(
      <DatasetPickerDialog
        open
        onClose={vi.fn()}
        onPick={onPick}
        canPick={() => false}
        cannotPickLabel="append_target_needs_edit_rights"
      />
    );
    fireEvent.click(screen.getByText("pick-roads"));
    const use = screen.getByRole("button", { name: "use_dataset" }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    expect(screen.getByText("append_target_needs_edit_rights")).toBeInTheDocument();
    fireEvent.click(use);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("renders nothing while closed", () => {
    const { container } = render(<DatasetPickerDialog open={false} onClose={vi.fn()} onPick={vi.fn()} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(screen.queryByText("pick-roads")).not.toBeInTheDocument();
  });
});
