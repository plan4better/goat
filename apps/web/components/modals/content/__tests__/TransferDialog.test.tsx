import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ContentItem, Space, TransferPreview } from "@/lib/validations/content";

const { previewTransferMock, transferContentMock, refreshContentFeedMock, toastSuccessMock, toastErrorMock } =
  vi.hoisted(() => ({
    previewTransferMock: vi.fn(),
    transferContentMock: vi.fn(),
    refreshContentFeedMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    toastErrorMock: vi.fn(),
  }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  }),
}));
vi.mock("react-toastify", () => ({ toast: { success: toastSuccessMock, error: toastErrorMock } }));
vi.mock("swr", () => ({ mutate: vi.fn() }));
vi.mock("@/lib/api/content", () => ({
  previewTransfer: previewTransferMock,
  transferContent: transferContentMock,
  refreshContentFeed: refreshContentFeedMock,
}));

import TransferDialog from "@/components/modals/content/TransferDialog";

const personalSpace: Space = {
  id: "space-personal",
  kind: "personal",
  name: "My Content",
  default_role: "viewer",
  my_role: "owner",
  team_id: null,
  organization_id: null,
};

const teamSpace: Space = {
  id: "space-team",
  kind: "team",
  name: "Design Team",
  default_role: "viewer",
  my_role: "owner",
  team_id: "team-1",
  organization_id: null,
};

const projectItem: ContentItem = {
  type: "project",
  id: "proj-1",
  name: "Project A",
  space_id: "space-personal",
  folder_id: null,
  updated_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  my_role: "owner",
  shared_with: null,
  is_shortcut: false,
  is_public: false,
  restricted: false,
  restricted_inherited: false,
};

const basePreview: TransferPreview = {
  items: [{ type: "project", id: "proj-1", name: "Project A" }],
  datasets: [
    { id: "d1", name: "Dataset One", owned: true, used_elsewhere: false },
    { id: "d2", name: "Dataset Two", owned: false, used_elsewhere: true },
  ],
  grants_to_drop: 2,
  folders_in_subtrees: 0,
  trashed_in_subtrees: 0,
  skipped_foreign: 0,
  name_collisions: [],
  warnings: [],
};

const noop = () => {};

describe("TransferDialog", () => {
  beforeEach(() => {
    previewTransferMock.mockReset();
    transferContentMock.mockReset();
    refreshContentFeedMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("shows the grants warning, pre-ticks owned datasets, disables foreign ones, and submits the ticked selection", async () => {
    previewTransferMock.mockResolvedValue(basePreview);
    transferContentMock.mockResolvedValue({ moved: { folder: 0, project: 1, layer: 0, bundle: 0 }, shortcuts: 1, trashed_moved: 0 });

    render(
      <TransferDialog
        items={[projectItem]}
        spaces={[personalSpace, teamSpace]}
        onClose={noop}
        onTransferred={noop}
      />
    );
    // Named by its title, as every AppDialog is.
    expect(screen.getByRole("dialog", { name: /^transfer_title/ })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText(/transfer_line_grants/)).toBeInTheDocument());

    const ownedCheckbox = screen.getByRole("checkbox", { name: "Dataset One" });
    const foreignCheckbox = screen.getByRole("checkbox", { name: "Dataset Two" });
    expect(ownedCheckbox).toHaveProperty("checked", true);
    expect(foreignCheckbox).toHaveProperty("checked", false);
    expect(foreignCheckbox).toHaveProperty("disabled", true);

    fireEvent.click(ownedCheckbox);
    expect(ownedCheckbox).toHaveProperty("checked", false);

    fireEvent.click(screen.getByRole("button", { name: /transfer_to/ }));

    await waitFor(() =>
      expect(transferContentMock).toHaveBeenCalledWith({
        items: [{ type: "project", id: "proj-1" }],
        target_space_id: "space-team",
        dataset_ids: [],
        leave_shortcut: true,
      })
    );
  });

  it("disables submit and shows the collision message when the preview reports a name collision", async () => {
    previewTransferMock.mockResolvedValue({ ...basePreview, name_collisions: ["home"] });

    render(
      <TransferDialog
        items={[projectItem]}
        spaces={[personalSpace, teamSpace]}
        onClose={noop}
        onTransferred={noop}
      />
    );

    await waitFor(() => expect(screen.getByText(/transfer_name_collision/)).toBeInTheDocument());

    const submit = screen.getByRole("button", { name: /transfer_to/ });
    expect(submit).toHaveProperty("disabled", true);
  });

  it("keeps the dialog open and shows the server error when the transfer is rejected", async () => {
    previewTransferMock.mockResolvedValue(basePreview);
    transferContentMock.mockRejectedValue(new Error("Name collision"));
    const onClose = vi.fn();

    render(
      <TransferDialog
        items={[projectItem]}
        spaces={[personalSpace, teamSpace]}
        onClose={onClose}
        onTransferred={noop}
      />
    );

    await waitFor(() => expect(screen.getByText(/transfer_line_grants/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /transfer_to/ }));

    await waitFor(() => expect(screen.getByText("Name collision")).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a fallback error and keeps submit disabled when the preview itself fails to load", async () => {
    previewTransferMock.mockRejectedValue(new Error(""));

    render(
      <TransferDialog
        items={[projectItem]}
        spaces={[personalSpace, teamSpace]}
        onClose={noop}
        onTransferred={noop}
      />
    );

    await waitFor(() => expect(screen.getByText("transfer_preview_failed")).toBeInTheDocument());

    const submit = screen.getByRole("button", { name: /transfer_to/ });
    expect(submit).toHaveProperty("disabled", true);
  });
});
