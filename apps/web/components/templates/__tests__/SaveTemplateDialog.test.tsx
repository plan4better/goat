import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TemplateApiError } from "@/lib/api/templates";
import { PREVIEW_NODE_SIZE } from "@/lib/templates/previewGeometry";
import { tagColor } from "@/lib/utils/tagColor";
import type { Space } from "@/lib/validations/content";
import type { Folder } from "@/lib/validations/folder";
import type { TemplatePreview, TemplateRead, TemplateSource } from "@/lib/validations/template";

import SaveTemplateDialog from "@/components/templates/SaveTemplateDialog";

const {
  previewTemplateMock,
  createTemplateMock,
  refreshTemplatesMock,
  refreshContentFeedMock,
  useSpacesMock,
  useFoldersMock,
  useUserProfileMock,
  useTemplateCategoriesMock,
  publishTemplateWithDetailMock,
  useWorkflowMock,
  useReportLayoutMock,
  renderWorkflowSnapshotMock,
  renderLayoutSnapshotMock,
  uploadAssetMock,
  toastErrorMock,
  useTemplatesFromSourceMock,
  refreshTemplateMock,
  updateTemplateMock,
  unpublishTemplateMock,
  readTemplateMock,
} = vi.hoisted(() => ({
  useTemplatesFromSourceMock: vi.fn(),
  refreshTemplateMock: vi.fn(),
  updateTemplateMock: vi.fn(),
  unpublishTemplateMock: vi.fn(),
  readTemplateMock: vi.fn(),
  previewTemplateMock: vi.fn(),
  createTemplateMock: vi.fn(),
  refreshTemplatesMock: vi.fn(),
  refreshContentFeedMock: vi.fn(),
  useSpacesMock: vi.fn(),
  useFoldersMock: vi.fn(),
  useUserProfileMock: vi.fn(),
  useTemplateCategoriesMock: vi.fn(),
  publishTemplateWithDetailMock: vi.fn(),
  useWorkflowMock: vi.fn(),
  useReportLayoutMock: vi.fn(),
  renderWorkflowSnapshotMock: vi.fn(),
  renderLayoutSnapshotMock: vi.fn(),
  uploadAssetMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  }),
}));

vi.mock("@/lib/api/content", () => ({
  useSpaces: useSpacesMock,
  refreshContentFeed: refreshContentFeedMock,
}));
vi.mock("@/lib/api/folders", () => ({ useFolders: useFoldersMock }));
vi.mock("@/lib/api/templates", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/templates")>("@/lib/api/templates");
  return {
    TemplateApiError: actual.TemplateApiError,
    previewTemplate: previewTemplateMock,
    createTemplate: createTemplateMock,
    refreshTemplates: refreshTemplatesMock,
    useTemplateCategories: useTemplateCategoriesMock,
    publishTemplateWithDetail: publishTemplateWithDetailMock,
    useTemplatesFromSource: useTemplatesFromSourceMock,
    refreshTemplate: refreshTemplateMock,
    updateTemplate: updateTemplateMock,
    unpublishTemplate: unpublishTemplateMock,
    readTemplate: readTemplateMock,
  };
});
vi.mock("@/lib/api/users", () => ({ useUserProfile: useUserProfileMock }));
vi.mock("@/lib/templates/thumbnailSnapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/templates/thumbnailSnapshot")>()),
  regenerateTemplateThumbnail: vi.fn(async (template: unknown) => template),
}));
vi.mock("@/lib/api/workflows", () => ({ useWorkflow: useWorkflowMock }));
vi.mock("@/lib/api/reportLayouts", () => ({ useReportLayout: useReportLayoutMock }));
vi.mock("@/lib/api/assets", () => ({ uploadAsset: uploadAssetMock }));
// Only the rasterising call is stubbed: the drawing the preview scaffold
// renders comes from the same module, and is the real one.
vi.mock("@/lib/templates/workflowSnapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/templates/workflowSnapshot")>()),
  renderWorkflowSnapshot: renderWorkflowSnapshotMock,
}));
vi.mock("@/lib/templates/layoutSnapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/templates/layoutSnapshot")>()),
  renderLayoutSnapshot: renderLayoutSnapshotMock,
}));
vi.mock("react-toastify", () => ({ toast: { error: toastErrorMock, success: vi.fn() } }));

/** The workflow the snapshot is drawn from: two nodes and the edge between
 * them, as the canvas stores them. */
const workflowWithTwoNodes = {
  id: "wf-1",
  updated_at: "2026-09-07T10:00:00Z",
  config: {
    nodes: [
      { id: "n1", type: "dataset", position: { x: 0, y: 0 }, data: { label: "Parks" } },
      { id: "n2", type: "tool", position: { x: 300, y: 0 }, data: { label: "Buffer" } },
    ],
    edges: [{ id: "e1", source: "n1", target: "n2" }],
  },
};

/** The layout the scaffold is drawn from: a landscape A4 page with one map
 * block on it, as the layout canvas stores them. */
const layoutWithOneElement = {
  id: "layout-1",
  updated_at: "2026-09-07T10:00:00Z",
  config: {
    page: { size: "A4", orientation: "landscape" },
    elements: [{ id: "el-1", type: "map", position: { x: 10, y: 10, width: 200, height: 150 } }],
  },
};

/** A file of a given type and apparent size, without allocating its bytes. */
const imageFile = (name: string, size = 4096, type = "image/png"): File => {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

let objectUrlCount = 0;

beforeEach(() => {
  useTemplatesFromSourceMock.mockReset().mockReturnValue({ templates: [], isLoading: false });
  refreshTemplateMock.mockReset();
  updateTemplateMock.mockReset();
  unpublishTemplateMock.mockReset();
  readTemplateMock.mockReset();
  objectUrlCount = 0;
  URL.createObjectURL = vi.fn(() => `blob:thumb-${++objectUrlCount}`);
  URL.revokeObjectURL = vi.fn();
  // A settled read that carried no payload: Save is gated on the snapshot,
  // so a default of "still loading" would leave the button disabled in every
  // test that is not about the picture. The snapshot tests below set their
  // own loaded payload.
  useWorkflowMock.mockReset().mockReturnValue({ workflow: undefined, isLoading: false, isError: undefined });
  useReportLayoutMock
    .mockReset()
    .mockReturnValue({ reportLayout: undefined, isLoading: false, isError: undefined });
  renderWorkflowSnapshotMock.mockReset().mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  renderLayoutSnapshotMock.mockReset().mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  uploadAssetMock.mockReset().mockResolvedValue({ url: "https://assets.example/thumb.png" });
  toastErrorMock.mockReset();
});

const personalSpace: Space = {
  id: "space-personal",
  kind: "personal",
  name: "My Content",
  default_role: "viewer",
  my_role: "owner",
  team_id: null,
  organization_id: null,
};

const homeFolder: Folder = {
  id: "folder-home",
  name: "home",
  space_id: "space-personal",
  is_owned: true,
  parent_id: null,
  depth: 0,
  restricted: false,
};

/** A folder the browser can be walked into, one level under the space root. */
const otherFolder: Folder = {
  id: "folder-2",
  name: "Other Folder",
  space_id: "space-personal",
  is_owned: true,
  parent_id: null,
  depth: 0,
  restricted: false,
};

const workflowSource: TemplateSource = {
  kind: "workflow",
  project_id: "proj-1",
  workflow_id: "wf-1",
};

const layoutSource: TemplateSource = {
  kind: "layout",
  project_id: "proj-1",
  layout_id: "layout-1",
};

const projectSource: TemplateSource = {
  kind: "project",
  project_id: "proj-1",
};

const emptyPreview: TemplatePreview = {
  detected_inputs: [],
  kinds: ["workflow"],
  datasets_needing_share: [],
};

const noop = () => undefined;

describe("SaveTemplateDialog", () => {
  beforeEach(() => {
    previewTemplateMock.mockReset();
    createTemplateMock.mockReset();
    refreshTemplatesMock.mockReset();
    refreshContentFeedMock.mockReset();
    publishTemplateWithDetailMock.mockReset();
    useSpacesMock.mockReset().mockReturnValue({ spaces: [personalSpace] });
    useFoldersMock.mockReset().mockReturnValue({ folders: [homeFolder, otherFolder] });
    useUserProfileMock.mockReset().mockReturnValue({ userProfile: { is_superuser: false } });
    useTemplateCategoriesMock.mockReset().mockReturnValue({ categories: [], isLoading: false });
  });

  it("previews on open with the default folder, and again when the location changes", async () => {
    previewTemplateMock.mockResolvedValue(emptyPreview);

    render(
      <SaveTemplateDialog source={workflowSource} defaultName="My Workflow" onClose={noop} onSaved={noop} />
    );

    await waitFor(() =>
      expect(previewTemplateMock).toHaveBeenCalledWith({ source: workflowSource, folder_id: "folder-home" })
    );

    fireEvent.click(screen.getByText("Other Folder"));

    await waitFor(() =>
      expect(previewTemplateMock).toHaveBeenCalledWith({ source: workflowSource, folder_id: "folder-2" })
    );
    expect(previewTemplateMock).toHaveBeenCalledTimes(2);
  });

  it("shows the inputs table defaulted from the preview and toggling a row flips its mode on save", async () => {
    previewTemplateMock.mockResolvedValue({
      detected_inputs: [
        {
          key: "k1",
          label: "Parks",
          mode: "ship",
          layer_id: "L1",
          layer_type: "feature",
          geometry_type: "polygon",
          from_catalog: false,
        },
      ],
      kinds: ["workflow"],
      datasets_needing_share: [],
    } satisfies TemplatePreview);
    createTemplateMock.mockResolvedValue({ id: "tmpl-1" } as unknown as TemplateRead);

    render(
      <SaveTemplateDialog source={workflowSource} defaultName="My Workflow" onClose={noop} onSaved={noop} />
    );

    const shipSwitch = await screen.findByRole("checkbox", { name: "Parks — ship_dataset" });
    expect(shipSwitch).toHaveProperty("checked", true);

    fireEvent.click(shipSwitch);
    expect(shipSwitch).toHaveProperty("checked", false);
    expect(screen.getByText("ask_on_use")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: [expect.objectContaining({ key: "k1", mode: "ask" })],
          share_datasets: [],
        })
      )
    );
  });

  it("shows the consequence block and excludes an opted-out dataset from share_datasets", async () => {
    previewTemplateMock.mockResolvedValue({
      detected_inputs: [
        {
          key: "k1",
          label: "Parks",
          mode: "ship",
          layer_id: "L1",
          layer_type: "feature",
          geometry_type: "polygon",
          from_catalog: false,
        },
        {
          key: "k2",
          label: "Trees",
          mode: "ship",
          layer_id: "L2",
          layer_type: "feature",
          geometry_type: "point",
          from_catalog: false,
        },
      ],
      kinds: ["workflow"],
      datasets_needing_share: [
        { layer_id: "L1", name: "Parks", from_catalog: false, current_audience: "personal" },
        { layer_id: "L2", name: "Trees", from_catalog: false, current_audience: "personal" },
      ],
    } satisfies TemplatePreview);
    createTemplateMock.mockResolvedValue({ id: "tmpl-1" } as unknown as TemplateRead);

    render(
      <SaveTemplateDialog source={workflowSource} defaultName="My Workflow" onClose={noop} onSaved={noop} />
    );

    await waitFor(() =>
      expect(
        screen.getByText('datasets_will_be_shared_viewer:{"n":2,"audience":"My Content"}')
      ).toBeInTheDocument()
    );

    const treesCheckbox = screen.getByRole("checkbox", { name: "Trees" });
    expect(treesCheckbox).toHaveProperty("checked", true);
    fireEvent.click(treesCheckbox);

    await waitFor(() =>
      expect(
        screen.getByText('datasets_will_be_shared_viewer:{"n":1,"audience":"My Content"}')
      ).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          share_datasets: ["L1"],
          inputs: expect.arrayContaining([expect.objectContaining({ key: "k2", mode: "ask" })]),
        })
      )
    );
  });

  it("hides the inputs table and shows the layouts note for a layout payload", async () => {
    previewTemplateMock.mockResolvedValue(emptyPreview);

    render(
      <SaveTemplateDialog source={layoutSource} defaultName="My Layout" onClose={noop} onSaved={noop} />
    );

    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    expect(screen.getByText("layouts_carry_no_datasets")).toBeInTheDocument();
    expect(screen.queryByText("template_inputs")).not.toBeInTheDocument();
  });

  it("shows a static ships_with_template label (no switch) for a project payload, and always submits mode=ship", async () => {
    previewTemplateMock.mockResolvedValue({
      detected_inputs: [
        {
          key: "layer:L1",
          label: "Parks",
          mode: "ship",
          layer_id: "L1",
          layer_type: "feature",
          geometry_type: "polygon",
          from_catalog: false,
        },
      ],
      kinds: ["project"],
      datasets_needing_share: [],
    } satisfies TemplatePreview);
    createTemplateMock.mockResolvedValue({ id: "tmpl-1" } as unknown as TemplateRead);

    render(
      <SaveTemplateDialog source={projectSource} defaultName="My Project" onClose={noop} onSaved={noop} />
    );

    await screen.findByText("Parks");

    expect(screen.getByText("ships_with_template")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /ship_dataset/ })).not.toBeInTheDocument();
    expect(screen.queryByText("ask_on_use")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: [expect.objectContaining({ key: "layer:L1", mode: "ship" })],
        })
      )
    );
  });

  it("hides the publish switch for a non-superuser", async () => {
    previewTemplateMock.mockResolvedValue(emptyPreview);

    render(
      <SaveTemplateDialog source={workflowSource} defaultName="My Workflow" onClose={noop} onSaved={noop} />
    );

    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());
    expect(screen.queryByText("publish_to_goat_catalog")).not.toBeInTheDocument();
  });

  it("shows the blocked layer names inline on a 409, and only reports the save once the author closes", async () => {
    useUserProfileMock.mockReturnValue({ userProfile: { is_superuser: true } });
    previewTemplateMock.mockResolvedValue(emptyPreview);
    const created = { id: "tmpl-1" } as unknown as TemplateRead;
    createTemplateMock.mockResolvedValue(created);
    publishTemplateWithDetailMock.mockResolvedValue({ ok: false, layers: [{ id: "L1", name: "Parks" }] });
    const onClose = vi.fn();
    const onSaved = vi.fn();

    render(
      <SaveTemplateDialog
        source={workflowSource}
        defaultName="My Workflow"
        onClose={onClose}
        onSaved={onSaved}
      />
    );

    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    fireEvent.click(screen.getByText("publish_to_goat_catalog"));
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(publishTemplateWithDetailMock).toHaveBeenCalledWith("tmpl-1"));
    await waitFor(() =>
      expect(screen.getByText(/template_dataset_not_public:{"names":"Parks"}/)).toBeInTheDocument()
    );
    expect(screen.getByText(/template_saved_not_published/)).toBeInTheDocument();

    // The save is only reported once the author has read the refusal —
    // every caller closes this dialog from `onSaved`.
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "save" })).not.toBeInTheDocument();
    expect(refreshTemplatesMock).toHaveBeenCalled();
    expect(refreshContentFeedMock).toHaveBeenCalled();

    // The header's own X carries the same label — the footer button is last.
    fireEvent.click(screen.getAllByRole("button", { name: "close" }).slice(-1)[0]);
    expect(onSaved).toHaveBeenCalledWith(created);
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the publish refusal on screen when the caller's onSaved unmounts the dialog", async () => {
    useUserProfileMock.mockReturnValue({ userProfile: { is_superuser: true } });
    previewTemplateMock.mockResolvedValue(emptyPreview);
    createTemplateMock.mockResolvedValue({ id: "tmpl-1" } as unknown as TemplateRead);
    publishTemplateWithDetailMock.mockResolvedValue({ ok: false, layers: [{ id: "L1", name: "Parks" }] });

    // Every real caller unmounts the dialog from `onSaved` (the workflows and
    // layouts panels clear their state, the map header flips its flag).
    const Host = () => {
      const [open, setOpen] = useState(true);
      if (!open) return <div>unmounted</div>;
      return (
        <SaveTemplateDialog
          source={workflowSource}
          defaultName="My Workflow"
          onClose={() => setOpen(false)}
          onSaved={() => setOpen(false)}
        />
      );
    };

    render(<Host />);

    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());
    fireEvent.click(screen.getByText("publish_to_goat_catalog"));
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() =>
      expect(screen.getByText(/template_dataset_not_public:{"names":"Parks"}/)).toBeInTheDocument()
    );
    expect(screen.queryByText("unmounted")).not.toBeInTheDocument();
  });

  it("names the unreadable input on a structured create failure", async () => {
    previewTemplateMock.mockResolvedValue({
      detected_inputs: [
        {
          key: "k1",
          label: "Parks",
          mode: "ship",
          layer_id: "L1",
          layer_type: "feature",
          geometry_type: "polygon",
          from_catalog: false,
        },
      ],
      kinds: ["workflow"],
      datasets_needing_share: [],
    } satisfies TemplatePreview);
    createTemplateMock.mockRejectedValue(
      new TemplateApiError("Failed to save template", {
        code: "template_input_not_readable",
        layer_id: "L1",
      })
    );

    render(
      <SaveTemplateDialog source={workflowSource} defaultName="My Workflow" onClose={noop} onSaved={noop} />
    );

    await screen.findByText("Parks");
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() =>
      expect(screen.getByText('template_input_not_readable:{"name":"Parks"}')).toBeInTheDocument()
    );
  });

  it("does not re-preview (or reset the author's choices) when an equal source object arrives", async () => {
    previewTemplateMock.mockResolvedValue({
      detected_inputs: [
        {
          key: "k1",
          label: "Parks",
          mode: "ship",
          layer_id: "L1",
          layer_type: "feature",
          geometry_type: "polygon",
          from_catalog: false,
        },
      ],
      kinds: ["workflow"],
      datasets_needing_share: [
        { layer_id: "L1", name: "Parks", from_catalog: false, current_audience: "personal" },
      ],
    } satisfies TemplatePreview);

    // Every caller builds `source` inline, so a parent re-render hands the
    // dialog a new object with the same fields.
    const { rerender } = render(
      <SaveTemplateDialog
        source={{ kind: "workflow", project_id: "proj-1", workflow_id: "wf-1" }}
        defaultName="My Workflow"
        onClose={noop}
        onSaved={noop}
      />
    );

    const shipSwitch = await screen.findByRole("checkbox", { name: "Parks — ship_dataset" });
    fireEvent.click(shipSwitch);
    expect(shipSwitch).toHaveProperty("checked", false);

    rerender(
      <SaveTemplateDialog
        source={{ kind: "workflow", project_id: "proj-1", workflow_id: "wf-1" }}
        defaultName="My Workflow"
        onClose={noop}
        onSaved={noop}
      />
    );

    expect(previewTemplateMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("checkbox", { name: "Parks — ship_dataset" })).toHaveProperty("checked", false);
    expect(screen.getByRole("checkbox", { name: "Parks" })).toHaveProperty("checked", false);
  });

  it("saves and closes on plain success", async () => {
    previewTemplateMock.mockResolvedValue(emptyPreview);
    const created = { id: "tmpl-1" } as unknown as TemplateRead;
    createTemplateMock.mockResolvedValue(created);
    const onClose = vi.fn();
    const onSaved = vi.fn();

    render(
      <SaveTemplateDialog
        source={workflowSource}
        defaultName="My Workflow"
        onClose={onClose}
        onSaved={onSaved}
      />
    );

    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));
    expect(onClose).toHaveBeenCalled();
    expect(publishTemplateWithDetailMock).not.toHaveBeenCalled();
  });
});

describe("SaveTemplateDialog — categories", () => {
  const facets = [
    { name: "Mobility", count: 4 },
    { name: "Transit", count: 2 },
  ];

  beforeEach(() => {
    previewTemplateMock.mockReset().mockResolvedValue(emptyPreview);
    createTemplateMock.mockReset().mockResolvedValue({ id: "tmpl-1" } as unknown as TemplateRead);
    refreshTemplatesMock.mockReset();
    refreshContentFeedMock.mockReset();
    publishTemplateWithDetailMock.mockReset();
    useSpacesMock.mockReset().mockReturnValue({ spaces: [personalSpace] });
    useFoldersMock.mockReset().mockReturnValue({ folders: [homeFolder, otherFolder] });
    useUserProfileMock.mockReset().mockReturnValue({ userProfile: { is_superuser: false } });
    useTemplateCategoriesMock.mockReset().mockReturnValue({ categories: facets, isLoading: false });
  });

  const open = async () => {
    render(
      <SaveTemplateDialog source={workflowSource} defaultName="My Workflow" onClose={noop} onSaved={noop} />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());
    return screen.getByLabelText("categories");
  };

  /** The tags currently on the field, as their chips read. */
  const chosen = () =>
    screen.getAllByRole("button").filter((node) => node.classList.contains("MuiChip-root"));

  it("labels the field above itself, with no floating label inside the input", async () => {
    const field = await open();

    const control = field.closest(".MuiFormControl-root");
    expect(control).not.toBeNull();
    expect(control?.querySelector(".MuiInputLabel-root")).toBeNull();
    expect(control?.querySelector("label")).toBeNull();
    // The label above the field is the FormLabelHelper line.
    expect(screen.getByText("categories")).toBeInTheDocument();
  });

  it("offers the categories in use with how many templates carry each", async () => {
    const field = await open();

    fireEvent.change(field, { target: { value: "mob" } });

    const option = await screen.findByRole("option");
    expect(option.textContent).toBe("Mobility · 4");
  });

  it("joins the existing tag when the author types it in another case", async () => {
    const field = await open();

    fireEvent.change(field, { target: { value: "mobility" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(chosen().map((chip) => chip.textContent)).toEqual(["Mobility"]);

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(expect.objectContaining({ categories: ["Mobility"] }))
    );
  });

  it("keeps a tag nothing matches as the author typed it", async () => {
    const field = await open();

    fireEvent.change(field, { target: { value: "Cargo bikes" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(chosen().map((chip) => chip.textContent)).toEqual(["Cargo bikes"]);

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({ categories: ["Cargo bikes"] })
      )
    );
  });

  it("takes a new tag once, whatever the spelling", async () => {
    const field = await open();

    fireEvent.change(field, { target: { value: "Cargo bikes" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.change(field, { target: { value: "CARGO BIKES" } });
    fireEvent.keyDown(field, { key: "Enter" });

    // The backend groups categories case-insensitively, so a second
    // spelling would be the same tag twice on the same template.
    expect(chosen().map((chip) => chip.textContent)).toEqual(["Cargo bikes"]);
  });

  it("keeps a tag the author typed but never committed when they press Save", async () => {
    const field = await open();

    fireEvent.change(field, { target: { value: "cargo" } });
    // No Enter: the Save click blurs the field, which is where the tag would
    // otherwise be dropped.
    fireEvent.blur(field);
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({ categories: expect.arrayContaining(["cargo"]) })
      )
    );
  });

  it("turns a comma inside a tag into a space, since a comma separates tags on the wire", async () => {
    const field = await open();

    fireEvent.change(field, { target: { value: "Bikes, cargo" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(chosen().map((chip) => chip.textContent)).toEqual(["Bikes cargo"]);

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({ categories: ["Bikes cargo"] })
      )
    );
  });

  it("drops a chosen tag from the options, so clicking it cannot untick it", async () => {
    const field = await open();

    fireEvent.change(field, { target: { value: "Mobility" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.change(field, { target: { value: "Mob" } });

    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("colours a chosen tag by its name", async () => {
    const field = await open();

    fireEvent.change(field, { target: { value: "Mobility" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(chosen()[0]).toHaveStyle({ color: tagColor("Mobility").fg });
  });
});

describe("SaveTemplateDialog — the live preview", () => {
  beforeEach(() => {
    previewTemplateMock.mockReset().mockResolvedValue(emptyPreview);
    createTemplateMock.mockReset().mockResolvedValue({ id: "tmpl-1" } as unknown as TemplateRead);
    refreshTemplatesMock.mockReset();
    refreshContentFeedMock.mockReset();
    publishTemplateWithDetailMock.mockReset();
    useSpacesMock.mockReset().mockReturnValue({ spaces: [personalSpace] });
    useFoldersMock.mockReset().mockReturnValue({ folders: [homeFolder, otherFolder] });
    useUserProfileMock
      .mockReset()
      .mockReturnValue({ userProfile: { id: "user-1", firstname: "Majk", lastname: "S" } });
    useTemplateCategoriesMock
      .mockReset()
      .mockReturnValue({ categories: [{ name: "Mobility", count: 4 }], isLoading: false });
  });

  const open = async () => {
    render(<SaveTemplateDialog source={workflowSource} defaultName="" onClose={noop} onSaved={noop} />);
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());
    return screen.getByTestId("template-preview-column");
  };

  it("stands a nameless draft in with a placeholder name, and follows what the author types", async () => {
    const column = await open();

    expect(within(column).getByText("untitled_template")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Bus network" } });

    expect(within(column).getByText("Bus network")).toBeInTheDocument();
    expect(within(column).queryByText("untitled_template")).not.toBeInTheDocument();
  });

  it("shows the chosen categories in the preview", async () => {
    const column = await open();

    fireEvent.change(screen.getByLabelText("categories"), { target: { value: "Mobility" } });
    fireEvent.keyDown(screen.getByLabelText("categories"), { key: "Enter" });

    expect(within(column).getByText("categories")).toBeInTheDocument();
    expect(within(column).getByText("Mobility")).toBeInTheDocument();
  });

  it("renders the description the author writes as markdown, not as its syntax", async () => {
    const column = await open();

    fireEvent.change(screen.getByLabelText("description"), {
      target: { value: "## Why\n\nCounts **stops** per line." },
    });

    const heading = within(column).getByText("Why");
    expect(heading.tagName).toBe("H2");
    expect(within(column).getByText("stops").tagName).toBe("STRONG");
  });

  it("badges the kinds the preview reported", async () => {
    const column = await open();

    expect(within(column).getByText("template_kind_workflow")).toBeInTheDocument();
  });

  it("writes the description in the markdown editor, with no tabs of its own", async () => {
    await open();

    // The preview column beside the form renders the markdown, so the editor
    // is the field and its syntax hint alone.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByText("markdown_syntax_hint")).toBeInTheDocument();
    // `MarkdownProse` draws no video, so the editor's poster hint stays off.
    expect(screen.queryByText("markdown_video_hint")).not.toBeInTheDocument();
  });

  it("browses the destination space's folders, root first", async () => {
    await open();

    // The label above the browser, the space crumb, and a folder to walk into.
    expect(screen.getByText("folder")).toBeInTheDocument();
    expect(screen.getByText("Other Folder")).toBeInTheDocument();
    expect(screen.getByText("template_folder_hint")).toBeInTheDocument();
  });
});

describe("SaveTemplateDialog — the thumbnail", () => {
  beforeEach(() => {
    previewTemplateMock.mockReset().mockResolvedValue(emptyPreview);
    createTemplateMock.mockReset().mockResolvedValue({ id: "tmpl-1" } as unknown as TemplateRead);
    refreshTemplatesMock.mockReset();
    refreshContentFeedMock.mockReset();
    publishTemplateWithDetailMock.mockReset();
    useSpacesMock.mockReset().mockReturnValue({ spaces: [personalSpace] });
    useFoldersMock.mockReset().mockReturnValue({ folders: [homeFolder, otherFolder] });
    useUserProfileMock.mockReset().mockReturnValue({ userProfile: { is_superuser: false } });
    useTemplateCategoriesMock.mockReset().mockReturnValue({ categories: [], isLoading: false });
  });

  /** The picture the preview column is showing, as its `src` reads. */
  const previewImageSrc = (): string | null =>
    screen.getByTestId("template-preview-column").querySelector("img")?.getAttribute("src") ?? null;

  /** Pick a file through the overlay's own input, the way the buttons on the
   * picture do. */
  const pick = (file: File) => {
    fireEvent.change(screen.getByTestId("thumbnail-upload-input"), { target: { files: [file] } });
  };

  const openWorkflow = async (name = "My Workflow") => {
    useWorkflowMock.mockReturnValue({
      workflow: workflowWithTwoNodes,
      isLoading: false,
      isError: undefined,
    });
    render(<SaveTemplateDialog source={workflowSource} defaultName={name} onClose={noop} onSaved={noop} />);
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());
  };

  it("draws the workflow's stored config and shows the snapshot in the preview before the save", async () => {
    await openWorkflow();

    expect(useWorkflowMock).toHaveBeenCalledWith("proj-1", "wf-1");
    await waitFor(() => expect(renderWorkflowSnapshotMock).toHaveBeenCalled());
    // The sizes are the canvas's own, which the geometry module owns.
    expect(renderWorkflowSnapshotMock.mock.calls[0][0]).toEqual({
      kind: "workflow",
      nodes: [
        // A dataset whose layer has no geometry reads as the table glyph,
        // and a tool with no process picked carries no icon name.
        {
          label: "Parks",
          type: "dataset",
          x: 0,
          y: 0,
          ...PREVIEW_NODE_SIZE.dataset,
          icon: "table",
          // Only an annotation carries a colour and its own markup.
          color: null,
          html: null,
        },
        {
          label: "Buffer",
          type: "tool",
          x: 300,
          y: 0,
          ...PREVIEW_NODE_SIZE.tool,
          icon: null,
          color: null,
          html: null,
        },
      ],
      edges: [[0, 1]],
    });

    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));
    expect(screen.queryByTestId("template-preview-thumbnail-loading")).not.toBeInTheDocument();
  });

  it("holds the preview's thumbnail box with a skeleton while the snapshot is being drawn", async () => {
    let resolveSnapshot: (blob: Blob) => void = () => undefined;
    renderWorkflowSnapshotMock.mockReturnValue(
      new Promise<Blob>((resolve) => {
        resolveSnapshot = resolve;
      })
    );

    await openWorkflow();

    expect(screen.getByTestId("template-preview-thumbnail-loading")).toBeInTheDocument();

    resolveSnapshot(new Blob(["png"], { type: "image/png" }));

    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));
    expect(screen.queryByTestId("template-preview-thumbnail-loading")).not.toBeInTheDocument();
  });

  it("leaves the scaffold in place when the snapshot cannot be drawn", async () => {
    renderWorkflowSnapshotMock.mockRejectedValue(new Error("no canvas"));

    await openWorkflow();

    await waitFor(() =>
      expect(screen.queryByTestId("template-preview-thumbnail-loading")).not.toBeInTheDocument()
    );
    expect(previewImageSrc()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(expect.objectContaining({ thumbnail_url: null }))
    );
    expect(uploadAssetMock).not.toHaveBeenCalled();
  });

  it("keeps Save disabled until the snapshot the template is stored with has been drawn", async () => {
    let resolveSnapshot: (blob: Blob) => void = () => undefined;
    renderWorkflowSnapshotMock.mockReturnValue(
      new Promise<Blob>((resolve) => {
        resolveSnapshot = resolve;
      })
    );

    await openWorkflow();

    // The picture takes up to four seconds per map element to render; saving
    // meanwhile would store the generic scaffold instead of it.
    const save = screen.getByRole("button", { name: "save" });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.click(save);
    expect(createTemplateMock).not.toHaveBeenCalled();

    resolveSnapshot(new Blob(["png"], { type: "image/png" }));

    await waitFor(() => expect(save).toHaveProperty("disabled", false));
    fireEvent.click(save);

    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnail_url: "https://assets.example/thumb.png" })
      )
    );
  });

  it("keeps Save disabled while the layout config its page label is read from is still loading", async () => {
    useReportLayoutMock.mockReturnValue({
      reportLayout: undefined,
      isLoading: true,
      isError: undefined,
    });

    const { rerender } = render(
      <SaveTemplateDialog source={layoutSource} defaultName="My Layout" onClose={noop} onSaved={noop} />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    // `page_size`/`page_orientation` come from that same config, so a save
    // now would store the layout without the page it prints on.
    expect(screen.getByRole("button", { name: "save" })).toHaveProperty("disabled", true);

    useReportLayoutMock.mockReturnValue({
      reportLayout: layoutWithOneElement,
      isLoading: false,
      isError: undefined,
    });
    rerender(
      <SaveTemplateDialog source={layoutSource} defaultName="My Layout" onClose={noop} onSaved={noop} />
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "save" })).toHaveProperty("disabled", false)
    );
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({ page_size: "A4", page_orientation: "landscape" })
      )
    );
  });

  it("draws no snapshot for a workflow with nothing placeable on its canvas", async () => {
    useWorkflowMock.mockReturnValue({
      workflow: { id: "wf-1", updated_at: "2026-09-07T10:00:00Z", config: { nodes: [], edges: [] } },
      isLoading: false,
      isError: undefined,
    });
    render(
      <SaveTemplateDialog source={workflowSource} defaultName="My Workflow" onClose={noop} onSaved={noop} />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    await waitFor(() =>
      expect(screen.queryByTestId("template-preview-thumbnail-loading")).not.toBeInTheDocument()
    );
    expect(renderWorkflowSnapshotMock).not.toHaveBeenCalled();
    expect(previewImageSrc()).toBeNull();
  });

  it("draws the layout's stored config and shows the snapshot in the preview before the save", async () => {
    useReportLayoutMock.mockReturnValue({
      reportLayout: layoutWithOneElement,
      isLoading: false,
      isError: undefined,
    });

    render(
      <SaveTemplateDialog source={layoutSource} defaultName="My Layout" onClose={noop} onSaved={noop} />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    expect(useWorkflowMock).toHaveBeenCalledWith(undefined, undefined);
    // A layout is drawn as its own wireframe, not through the workflow
    // renderer, and from the page and blocks its stored config carries.
    await waitFor(() => expect(renderLayoutSnapshotMock).toHaveBeenCalled());
    expect(renderWorkflowSnapshotMock).not.toHaveBeenCalled();
    expect(renderLayoutSnapshotMock.mock.calls[0][0]).toEqual({
      kind: "layout",
      orientation: "landscape",
      page: { width: 297, height: 210 },
      elements: [{ type: "map", x: 10, y: 10, width: 200, height: 150 }],
    });

    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));
    expect(screen.queryByTestId("template-preview-thumbnail-loading")).not.toBeInTheDocument();
  });

  it("holds the layout's thumbnail box with a skeleton while its wireframe is being drawn", async () => {
    let resolveSnapshot: (blob: Blob) => void = () => undefined;
    renderLayoutSnapshotMock.mockReturnValue(
      new Promise<Blob>((resolve) => {
        resolveSnapshot = resolve;
      })
    );
    useReportLayoutMock.mockReturnValue({
      reportLayout: layoutWithOneElement,
      isLoading: false,
      isError: undefined,
    });

    render(
      <SaveTemplateDialog source={layoutSource} defaultName="My Layout" onClose={noop} onSaved={noop} />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    expect(screen.getByTestId("template-preview-thumbnail-loading")).toBeInTheDocument();

    resolveSnapshot(new Blob(["png"], { type: "image/png" }));

    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));
    expect(screen.queryByTestId("template-preview-thumbnail-loading")).not.toBeInTheDocument();
  });

  it("uploads the generated layout wireframe on save and writes the returned url", async () => {
    useReportLayoutMock.mockReturnValue({
      reportLayout: layoutWithOneElement,
      isLoading: false,
      isError: undefined,
    });

    render(
      <SaveTemplateDialog source={layoutSource} defaultName="My Layout" onClose={noop} onSaved={noop} />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(uploadAssetMock).toHaveBeenCalled());
    const [file, assetType] = uploadAssetMock.mock.calls[0];
    expect((file as File).name).toBe("my-layout.png");
    expect((file as File).type).toBe("image/png");
    expect(assetType).toBe("image");
    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnail_url: "https://assets.example/thumb.png" })
      )
    );
  });

  it("draws no snapshot for a project source", async () => {
    render(
      <SaveTemplateDialog source={projectSource} defaultName="My Project" onClose={noop} onSaved={noop} />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    expect(renderWorkflowSnapshotMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("template-preview-thumbnail-loading")).not.toBeInTheDocument();
  });

  it("swaps the preview to a picked image, and puts the snapshot back on reset", async () => {
    await openWorkflow();
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));

    expect(screen.queryByRole("button", { name: "reset_to_generated" })).not.toBeInTheDocument();

    pick(imageFile("shot.png"));

    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-2"));

    fireEvent.click(screen.getByRole("button", { name: "reset_to_generated" }));

    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:thumb-2");
    expect(screen.queryByRole("button", { name: "reset_to_generated" })).not.toBeInTheDocument();
  });

  it("rejects an image over 2 MB and keeps the snapshot", async () => {
    await openWorkflow();
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));

    pick(imageFile("big.png", 2 * 1024 * 1024 + 1));

    expect(toastErrorMock).toHaveBeenCalledWith('thumbnail_too_large:{"mb":2}');
    expect(previewImageSrc()).toBe("blob:thumb-1");
  });

  it("rejects a file that is not one of the offered image types", async () => {
    await openWorkflow();
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));

    pick(imageFile("map.pdf", 4096, "application/pdf"));

    expect(toastErrorMock).toHaveBeenCalledWith("thumbnail_invalid_type");
    expect(previewImageSrc()).toBe("blob:thumb-1");
  });

  it("carries the two actions on the picture, not a field in the form", async () => {
    await openWorkflow();
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));

    const picture = screen.getByTestId("template-preview-thumbnail");
    expect(within(picture).getByRole("button", { name: "upload_image" })).toBeInTheDocument();
    expect(within(picture).getByTestId("thumbnail-upload-input").getAttribute("accept")).toBe(
      "image/png,image/jpeg,image/webp"
    );
    // The form is the fields alone — the picture is where the thumbnail is
    // chosen.
    expect(screen.queryByText("thumbnail")).not.toBeInTheDocument();
  });

  it("uploads the generated snapshot on save and writes the returned url", async () => {
    await openWorkflow();
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(uploadAssetMock).toHaveBeenCalled());
    const [file, assetType, options] = uploadAssetMock.mock.calls[0];
    expect(file).toBeInstanceOf(File);
    // The snapshot is named after the template, the asset store lists files
    // by name.
    expect((file as File).name).toBe("my-workflow.png");
    expect((file as File).type).toBe("image/png");
    expect(assetType).toBe("image");
    expect(options).toEqual(expect.objectContaining({ displayName: "my-workflow.png" }));

    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnail_url: "https://assets.example/thumb.png" })
      )
    );
  });

  it("reuses the picture already uploaded when a failed save is retried", async () => {
    createTemplateMock.mockRejectedValueOnce(new Error("boom"));
    const onSaved = vi.fn();
    useWorkflowMock.mockReturnValue({
      workflow: workflowWithTwoNodes,
      isLoading: false,
      isError: undefined,
    });
    render(
      <SaveTemplateDialog
        source={workflowSource}
        defaultName="My Workflow"
        onClose={noop}
        onSaved={onSaved}
      />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));

    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
    expect(uploadAssetMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    // The asset the first attempt stored is the one the template is saved
    // with: the retry neither orphans it nor uploads a second copy.
    expect(uploadAssetMock).toHaveBeenCalledTimes(1);
    expect(createTemplateMock).toHaveBeenCalledTimes(2);
    expect(createTemplateMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({ thumbnail_url: "https://assets.example/thumb.png" })
    );
  });

  it("uploads the picture picked after a failed save, rather than the one already stored", async () => {
    createTemplateMock.mockRejectedValueOnce(new Error("boom"));
    const onSaved = vi.fn();
    useWorkflowMock.mockReturnValue({
      workflow: workflowWithTwoNodes,
      isLoading: false,
      isError: undefined,
    });
    render(
      <SaveTemplateDialog
        source={workflowSource}
        defaultName="My Workflow"
        onClose={noop}
        onSaved={onSaved}
      />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));

    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());

    uploadAssetMock.mockResolvedValue({ url: "https://assets.example/picked.png" });
    pick(imageFile("city-map.png"));
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-2"));

    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    expect(uploadAssetMock).toHaveBeenCalledTimes(2);
    expect(createTemplateMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({ thumbnail_url: "https://assets.example/picked.png" })
    );
  });

  it("uploads a picked image under its own name", async () => {
    await openWorkflow();
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));

    pick(imageFile("city-map.webp", 4096, "image/webp"));
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-2"));

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(uploadAssetMock).toHaveBeenCalled());
    expect((uploadAssetMock.mock.calls[0][0] as File).name).toBe("city-map.webp");
    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnail_url: "https://assets.example/thumb.png" })
      )
    );
  });

  it("saves the template without a thumbnail when the upload fails", async () => {
    uploadAssetMock.mockRejectedValue(new Error("507"));
    const onSaved = vi.fn();
    useWorkflowMock.mockReturnValue({
      workflow: workflowWithTwoNodes,
      isLoading: false,
      isError: undefined,
    });
    render(
      <SaveTemplateDialog
        source={workflowSource}
        defaultName="My Workflow"
        onClose={noop}
        onSaved={onSaved}
      />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());
    await waitFor(() => expect(renderWorkflowSnapshotMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("image_upload_failed"));
    expect(createTemplateMock).toHaveBeenCalledWith(expect.objectContaining({ thumbnail_url: null }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("keeps the caller's default thumbnail when nothing was drawn or picked", async () => {
    render(
      <SaveTemplateDialog
        source={layoutSource}
        defaultName="My Layout"
        defaultThumbnailUrl="https://assets.example/layout.png"
        onClose={noop}
        onSaved={noop}
      />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    expect(previewImageSrc()).toBe("https://assets.example/layout.png");

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() =>
      expect(createTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnail_url: "https://assets.example/layout.png" })
      )
    );
    expect(uploadAssetMock).not.toHaveBeenCalled();
  });

  it("uploads a picture picked over the caller's default", async () => {
    render(
      <SaveTemplateDialog
        source={layoutSource}
        defaultName="My Layout"
        defaultThumbnailUrl="https://assets.example/layout.png"
        onClose={noop}
        onSaved={noop}
      />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    pick(imageFile("shot.jpg", 4096, "image/jpeg"));
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(uploadAssetMock).toHaveBeenCalled());
    expect((uploadAssetMock.mock.calls[0][0] as File).name).toBe("shot.jpg");
  });

  it("stops waiting for a snapshot the workflow read could not deliver", async () => {
    useWorkflowMock.mockReturnValue({ workflow: undefined, isLoading: false, isError: new Error("403") });
    render(
      <SaveTemplateDialog source={workflowSource} defaultName="My Workflow" onClose={noop} onSaved={noop} />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    await waitFor(() =>
      expect(screen.queryByTestId("template-preview-thumbnail-loading")).not.toBeInTheDocument()
    );
    expect(renderWorkflowSnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps the caller's default thumbnail when the upload of a picked image fails", async () => {
    uploadAssetMock.mockRejectedValue(new Error("507"));
    const onSaved = vi.fn();
    render(
      <SaveTemplateDialog
        source={layoutSource}
        defaultName="My Layout"
        defaultThumbnailUrl="https://assets.example/layout.png"
        onClose={noop}
        onSaved={onSaved}
      />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    pick(imageFile("shot.png"));
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("image_upload_failed"));
    // The picture the layout already had is not lost because the new one
    // could not be stored.
    expect(createTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({ thumbnail_url: "https://assets.example/layout.png" })
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("draws the workflow's own structure in the preview when no picture could be made", async () => {
    renderWorkflowSnapshotMock.mockRejectedValue(new Error("no canvas"));

    await openWorkflow();

    const column = screen.getByTestId("template-preview-column");
    // The scaffold before the save is the one the saved card will draw, not
    // the neutral placeholder.
    await waitFor(() => expect(within(column).getAllByTestId("template-preview-node")).toHaveLength(2));
    expect(within(column).getAllByTestId("template-preview-edge")).toHaveLength(1);
    expect(within(column).queryByTestId("template-preview-step")).not.toBeInTheDocument();
  });

  it("draws the layout's own page and blocks in the preview when no picture could be made", async () => {
    renderLayoutSnapshotMock.mockRejectedValue(new Error("no canvas"));
    useReportLayoutMock.mockReturnValue({
      reportLayout: layoutWithOneElement,
      isLoading: false,
      isError: undefined,
    });

    render(
      <SaveTemplateDialog source={layoutSource} defaultName="My Layout" onClose={noop} onSaved={noop} />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    expect(useReportLayoutMock).toHaveBeenCalledWith("proj-1", "layout-1");
    const column = screen.getByTestId("template-preview-column");
    const page = within(column).getByTestId("template-preview-page");
    expect(page.getAttribute("data-orientation")).toBe("landscape");
    expect(within(column).getAllByTestId("template-preview-element")).toHaveLength(1);
  });

  it("draws the project's mark in the preview", async () => {
    previewTemplateMock.mockResolvedValue({
      detected_inputs: [
        {
          key: "layer:L1",
          label: "Parks",
          mode: "ship",
          layer_id: "L1",
          layer_type: "feature",
          geometry_type: "polygon",
          from_catalog: false,
        },
      ],
      kinds: ["project"],
      datasets_needing_share: [],
    } satisfies TemplatePreview);

    render(
      <SaveTemplateDialog source={projectSource} defaultName="My Project" onClose={noop} onSaved={noop} />
    );
    await waitFor(() => expect(previewTemplateMock).toHaveBeenCalled());

    const column = screen.getByTestId("template-preview-column");
    expect(within(column).getByTestId("template-preview-project")).toBeInTheDocument();
    expect(useReportLayoutMock).toHaveBeenCalledWith(undefined, undefined);
  });

  it("revokes the object URLs it made when the dialog goes away", async () => {
    await openWorkflow();
    await waitFor(() => expect(previewImageSrc()).toBe("blob:thumb-1"));

    cleanup();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:thumb-1");
  });
});

const existing = (id: string, name: string, updated: string): TemplateRead =>
  ({
    id,
    name,
    description: "Old description",
    categories: ["Public transport"],
    thumbnail_url: null,
    space_id: "00000000-0000-0000-0000-000000000001",
    folder_id: "00000000-0000-0000-0000-000000000002",
    created_by: null,
    payload_kind: "workflow",
    kinds: ["workflow"],
    inputs: [],
    ships_sample_data: false,
    catalog_status: "none",
    source_ref: {},
    my_role: "owner",
    created_at: updated,
    updated_at: updated,
    datasets_needing_share: [],
  }) as unknown as TemplateRead;

describe("SaveTemplateDialog — templates from the same source", () => {
  beforeEach(() => {
    useSpacesMock.mockReset().mockReturnValue({ spaces: [personalSpace] });
    useFoldersMock.mockReset().mockReturnValue({ folders: [homeFolder, otherFolder] });
    useTemplateCategoriesMock.mockReset().mockReturnValue({ categories: [], isLoading: false });
    createTemplateMock.mockReset();
    publishTemplateWithDetailMock.mockReset();
    refreshTemplatesMock.mockReset();
    refreshContentFeedMock.mockReset();
    previewTemplateMock.mockReset().mockResolvedValue(emptyPreview);
    useUserProfileMock.mockReturnValue({ userProfile: { is_superuser: false } });
  });

  it("defaults to updating the latest template saved from this workflow and prefills its metadata", async () => {
    useTemplatesFromSourceMock.mockReturnValue({
      templates: [
        existing("00000000-0000-0000-0000-0000000000aa", "Newest", "2026-09-09T10:00:00Z"),
        existing("00000000-0000-0000-0000-0000000000bb", "Older", "2026-08-01T10:00:00Z"),
      ],
      isLoading: false,
    });
    render(<SaveTemplateDialog source={workflowSource} defaultName="My Workflow" onClose={noop} onSaved={noop} />);
    await screen.findByRole("radio", { name: /Newest/ });
    await expect(screen.getByRole("radio", { name: /Newest/ })).toBeChecked();
    await waitFor(() => expect(screen.getByLabelText("name")).toHaveValue("Newest"));
    expect(screen.getByRole("button", { name: "update_template" })).toBeInTheDocument();
    expect(screen.queryByText("location")).not.toBeInTheDocument();
  });

  it("refreshes then patches the chosen template instead of creating one", async () => {
    const newest = existing("00000000-0000-0000-0000-0000000000aa", "Newest", "2026-09-09T10:00:00Z");
    useTemplatesFromSourceMock.mockReturnValue({ templates: [newest], isLoading: false });
    refreshTemplateMock.mockResolvedValue({ ...newest, updated_at: "2026-09-11T10:00:00Z" });
    updateTemplateMock.mockResolvedValue({ ...newest, name: "Renamed" });
    const onSaved = vi.fn();
    render(<SaveTemplateDialog source={workflowSource} defaultName="My Workflow" onClose={noop} onSaved={onSaved} />);
    await screen.findByRole("radio", { name: /Newest/ });
    await waitFor(() => expect(screen.getByLabelText("name")).toHaveValue("Newest"));
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "update_template" }));
    await waitFor(() =>
      expect(updateTemplateMock).toHaveBeenCalledWith(newest.id, expect.objectContaining({ name: "Renamed" }))
    );
    expect(refreshTemplateMock).toHaveBeenCalledWith(newest.id);
    expect(createTemplateMock).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it("saves a new template when the author switches to save-as-new", async () => {
    useTemplatesFromSourceMock.mockReturnValue({
      templates: [existing("00000000-0000-0000-0000-0000000000aa", "Newest", "2026-09-09T10:00:00Z")],
      isLoading: false,
    });
    render(<SaveTemplateDialog source={workflowSource} defaultName="My Workflow" onClose={noop} onSaved={noop} />);
    await screen.findByRole("button", { name: "save_as_new" });
    fireEvent.click(screen.getByRole("button", { name: "save_as_new" }));
    await waitFor(() => expect(screen.getByLabelText("name")).toHaveValue("My Workflow"));
    expect(screen.getByRole("button", { name: "save" })).toBeInTheDocument();
    expect(screen.getByText("location")).toBeInTheDocument();
  });
});

describe("SaveTemplateDialog — edit mode", () => {
  const saved = {
    ...existing("00000000-0000-0000-0000-0000000000ee", "Saved template", "2026-09-09T10:00:00Z"),
    inputs: [
      {
        key: "stops",
        label: "GTFS stops",
        mode: "ship",
        layer_id: "00000000-0000-0000-0000-000000000031",
        layer_type: "feature",
        geometry_type: null,
        from_catalog: true,
      },
    ],
    source_ref: {
      kind: "workflow",
      project_id: "00000000-0000-0000-0000-000000000001",
      workflow_id: "00000000-0000-0000-0000-000000000011",
      layout_id: null,
    },
    source: {
      kind: "workflow",
      project_id: "00000000-0000-0000-0000-000000000001",
      project_name: "Analysis",
      workflow_id: "00000000-0000-0000-0000-000000000011",
      workflow_name: "Güteklassen",
      layout_id: null,
      layout_name: null,
      available: true,
    },
  } as unknown as TemplateRead;

  beforeEach(() => {
    useSpacesMock.mockReset().mockReturnValue({ spaces: [personalSpace] });
    useFoldersMock.mockReset().mockReturnValue({ folders: [homeFolder, otherFolder] });
    useTemplateCategoriesMock.mockReset().mockReturnValue({ categories: [], isLoading: false });
    createTemplateMock.mockReset();
    publishTemplateWithDetailMock.mockReset();
    refreshTemplatesMock.mockReset();
    refreshContentFeedMock.mockReset();
    previewTemplateMock.mockReset();
    useUserProfileMock.mockReturnValue({ userProfile: { is_superuser: false } });
  });

  it("opens prefilled, with the inputs read-only and no location", async () => {
    render(<SaveTemplateDialog template={saved} onClose={noop} onSaved={noop} />);
    expect(screen.getByText("edit_template")).toBeInTheDocument();
    await expect(screen.getByLabelText("name")).toHaveValue("Saved template");
    // The input row is listed, and its switch is frozen with the snapshot.
    expect(screen.getByTestId("template-input-row-stops")).toBeInTheDocument();
    await expect(screen.getByRole("checkbox", { name: /GTFS stops/ })).toBeDisabled();
    expect(screen.getByText("inputs_frozen_hint")).toBeInTheDocument();
    expect(screen.queryByText("location")).not.toBeInTheDocument();
    await expect(screen.getByRole("link", { name: /Güteklassen/ })).toHaveAttribute(
      "href",
      "/map/00000000-0000-0000-0000-000000000001?workflow=00000000-0000-0000-0000-000000000011"
    );
    expect(previewTemplateMock).not.toHaveBeenCalled();
    expect(useTemplatesFromSourceMock).toHaveBeenCalledWith(null);
  });

  it("patches the metadata on save changes", async () => {
    updateTemplateMock.mockResolvedValue({ ...saved, name: "Renamed" });
    const onSaved = vi.fn();
    render(<SaveTemplateDialog template={saved} onClose={noop} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "save_changes" }));
    await waitFor(() =>
      expect(updateTemplateMock).toHaveBeenCalledWith(saved.id, expect.objectContaining({ name: "Renamed" }))
    );
    expect(createTemplateMock).not.toHaveBeenCalled();
    expect(refreshTemplateMock).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it("refreshes from the source from the snapshot line and re-reads the template", async () => {
    refreshTemplateMock.mockResolvedValue({ ...saved, updated_at: "2026-09-11T10:00:00Z" });
    readTemplateMock.mockResolvedValue({ ...saved, updated_at: "2026-09-11T10:00:00Z" });
    render(<SaveTemplateDialog template={saved} onClose={noop} onSaved={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "update_template_from_source" }));
    await waitFor(() => expect(refreshTemplateMock).toHaveBeenCalledWith(saved.id));
    await waitFor(() => expect(readTemplateMock).toHaveBeenCalledWith(saved.id));
  });
});
