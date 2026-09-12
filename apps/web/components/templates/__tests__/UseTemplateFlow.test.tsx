import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { USERS_API_BASE_URL } from "@/lib/api/users";
import type { Folder } from "@/lib/validations/folder";
import type { TemplateInput, TemplateRead, TemplateUseResult } from "@/lib/validations/template";

import UseTemplateFlow from "@/components/templates/UseTemplateFlow";

const {
  applyTemplateMock,
  refreshTemplatesMock,
  refreshContentFeedMock,
  useSpacesMock,
  useContentMock,
  useFoldersMock,
  useProjectLayersMock,
  toastSuccessMock,
  toastInfoMock,
  swrMutateMock,
} = vi.hoisted(() => ({
  applyTemplateMock: vi.fn(),
  refreshTemplatesMock: vi.fn(),
  refreshContentFeedMock: vi.fn(),
  useSpacesMock: vi.fn(),
  useContentMock: vi.fn(),
  useFoldersMock: vi.fn(),
  useProjectLayersMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastInfoMock: vi.fn(),
  swrMutateMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  }),
}));
vi.mock("react-toastify", () => ({ toast: { success: toastSuccessMock, info: toastInfoMock } }));
vi.mock("swr", () => ({ mutate: swrMutateMock }));
vi.mock("@/lib/api/templates", () => ({
  applyTemplate: applyTemplateMock,
  refreshTemplates: refreshTemplatesMock,
}));
vi.mock("@/lib/api/content", () => ({
  useSpaces: useSpacesMock,
  useContent: useContentMock,
  refreshContentFeed: refreshContentFeedMock,
}));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));
vi.mock("@/lib/api/folders", () => ({ useFolders: useFoldersMock }));
vi.mock("@/lib/api/projects", () => ({ useProjectLayers: useProjectLayersMock }));

const personalSpace = {
  id: "space-1",
  kind: "personal" as const,
  name: "Majk",
  default_role: "viewer" as const,
  my_role: "owner" as const,
  team_id: null,
  organization_id: null,
};

const homeFolder: Folder = {
  id: "folder-home",
  name: "home",
  parent_id: null,
  space_id: "space-1",
  depth: 0,
  is_owned: true,
  restricted: false,
};

const projectRow = (id: string, name: string, my_role: "owner" | "editor" | "viewer" = "owner") => ({
  type: "project" as const,
  id,
  name,
  space_id: "space-1",
  folder_id: "folder-home",
  updated_at: "2026-09-10T10:00:00Z",
  created_at: "2026-09-01T10:00:00Z",
  my_role,
  created_by: null,
  shared_with: null,
  thumbnail_url: null,
  is_public: false,
  is_shortcut: false,
  restricted: false,
  restricted_inherited: false,
});

const projectPage = (items: ReturnType<typeof projectRow>[]) => ({
  page: { items, total: items.length, page: 1, size: 50 },
  isLoading: false,
  isError: undefined,
});

const askInput: TemplateInput = {
  key: "input_layer",
  label: "Streets",
  mode: "ask",
  layer_id: null,
  layer_type: "feature",
  geometry_type: "point",
  from_catalog: false,
};

const baseTemplate: TemplateRead = {
  id: "template-1",
  name: "Isochrone starter",
  description: "A starter workflow",
  categories: [],
  thumbnail_url: null,
  space_id: "space-1",
  folder_id: "folder-home",
  created_by: null,
  payload_kind: "workflow",
  kinds: ["workflow"],
  inputs: [],
  ships_sample_data: false,
  datasets_needing_share: [],
  catalog_status: "none",
  source_ref: {},
  my_role: "viewer",
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-01T10:00:00Z",
};

const templateWithAsk: TemplateRead = { ...baseTemplate, inputs: [askInput] };

const useResult: TemplateUseResult = {
  project_id: "project-1",
  workflow_id: "workflow-1",
  layout_id: null,
  added_layer_project_ids: [],
  unresolved_inputs: [],
};

/** Opens the layer picker of one input row and returns its listbox. */
const openPicker = (inputKey: string) => {
  fireEvent.mouseDown(within(screen.getByTestId(`template-use-input-${inputKey}`)).getByRole("combobox"));
  return screen.getByRole("listbox");
};

const noop = () => {};

describe("UseTemplateFlow", () => {
  beforeEach(() => {
    applyTemplateMock.mockReset().mockResolvedValue(useResult);
    refreshTemplatesMock.mockReset();
    refreshContentFeedMock.mockReset();
    toastSuccessMock.mockReset();
    toastInfoMock.mockReset();
    swrMutateMock.mockReset();
    useSpacesMock
      .mockReset()
      .mockReturnValue({ spaces: [personalSpace], isLoading: false, isError: undefined });
    useFoldersMock
      .mockReset()
      .mockReturnValue({ folders: [homeFolder], isLoading: false, isError: undefined });
    useContentMock.mockReset().mockReturnValue(projectPage([]));
    useProjectLayersMock.mockReset().mockReturnValue({ layers: [], isLoading: false, isError: undefined });
  });

  it("shows the location step outside a project when the caller has no projects", () => {
    render(
      <UseTemplateFlow
        template={templateWithAsk}
        context={{ kind: "outside_project" }}
        onClose={noop}
        onDone={noop}
      />
    );

    expect(screen.getByText("location")).toBeInTheDocument();
    // The name field carries its label above itself, not as a floating one
    // inside the input.
    expect(document.querySelector(".MuiInputLabel-root")).toBeNull();
    expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe(templateWithAsk.name);
  });

  it("skips the location step for an in_project context", () => {
    render(
      <UseTemplateFlow
        template={templateWithAsk}
        context={{ kind: "in_project", projectId: "project-1" }}
        onClose={noop}
        onDone={noop}
      />
    );

    expect(screen.queryByText("location")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("name")).not.toBeInTheDocument();
  });

  it("offers a layer picker for an ask input when a matching project layer exists (in_project)", () => {
    useProjectLayersMock.mockReturnValue({
      layers: [
        {
          id: 1,
          layer_id: "layer-uuid-1",
          name: "Roads",
          type: "feature",
          feature_layer_geometry_type: "point",
        },
      ],
      isLoading: false,
      isError: undefined,
    });

    render(
      <UseTemplateFlow
        template={templateWithAsk}
        context={{ kind: "in_project", projectId: "project-1" }}
        onClose={noop}
        onDone={noop}
      />
    );

    const menu = openPicker(askInput.key);
    expect(within(menu).getByRole("option", { name: "Roads" })).toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: "decide_later" })).toBeInTheDocument();
  });

  it("offers a dataset the project links twice only once", () => {
    const roads = {
      layer_id: "layer-uuid-1",
      name: "Roads",
      type: "feature",
      feature_layer_geometry_type: "point",
    };
    useProjectLayersMock.mockReturnValue({
      layers: [
        { id: 1, ...roads },
        { id: 2, ...roads },
      ],
      isLoading: false,
      isError: undefined,
    });

    render(
      <UseTemplateFlow
        template={templateWithAsk}
        context={{ kind: "in_project", projectId: "project-1" }}
        onClose={noop}
        onDone={noop}
      />
    );

    expect(within(openPicker(askInput.key)).getAllByRole("option", { name: "Roads" })).toHaveLength(1);
  });

  it("excludes a locked layer from an ask input's candidates (in_project)", () => {
    useProjectLayersMock.mockReturnValue({
      layers: [
        {
          id: 1,
          layer_id: "layer-uuid-1",
          name: "Roads",
          type: "feature",
          feature_layer_geometry_type: "point",
          locked: false,
        },
        {
          id: 2,
          layer_id: "layer-uuid-2",
          name: "No Access Layer",
          type: "feature",
          feature_layer_geometry_type: "point",
          locked: true,
        },
      ],
      isLoading: false,
      isError: undefined,
    });

    render(
      <UseTemplateFlow
        template={templateWithAsk}
        context={{ kind: "in_project", projectId: "project-1" }}
        onClose={noop}
        onDone={noop}
      />
    );

    const menu = openPicker(askInput.key);
    expect(within(menu).getByRole("option", { name: "Roads" })).toBeInTheDocument();
    expect(within(menu).queryByRole("option", { name: "No Access Layer" })).not.toBeInTheDocument();
  });

  it("offers no picker for an ask input when a new project is the target", () => {
    render(
      <UseTemplateFlow
        template={templateWithAsk}
        context={{ kind: "outside_project" }}
        onClose={noop}
        onDone={noop}
      />
    );

    // Advance past the location step (defaults are already valid).
    fireEvent.click(screen.getByRole("button", { name: "next_step" }));

    expect(
      within(screen.getByTestId(`template-use-input-${askInput.key}`)).queryByRole("combobox")
    ).toBeNull();
    expect(screen.getByText("no_matching_layer")).toBeInTheDocument();
  });

  it("applies with target_folder_id + name when a new project is the target", async () => {
    render(
      <UseTemplateFlow
        template={baseTemplate}
        context={{ kind: "outside_project" }}
        onClose={noop}
        onDone={noop}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await waitFor(() =>
      expect(applyTemplateMock).toHaveBeenCalledWith("template-1", {
        target_folder_id: "folder-home",
        name: "Isochrone starter",
        bindings: {},
      })
    );
  });

  it("applies with project_id for an in_project context and includes a chosen binding", async () => {
    useProjectLayersMock.mockReturnValue({
      layers: [
        {
          id: 1,
          layer_id: "layer-uuid-1",
          name: "Roads",
          type: "feature",
          feature_layer_geometry_type: "point",
        },
      ],
      isLoading: false,
      isError: undefined,
    });

    render(
      <UseTemplateFlow
        template={templateWithAsk}
        context={{ kind: "in_project", projectId: "project-1" }}
        onClose={noop}
        onDone={noop}
      />
    );

    fireEvent.click(within(openPicker(askInput.key)).getByRole("option", { name: "Roads" }));
    fireEvent.click(screen.getByRole("button", { name: "add_to_project" }));

    await waitFor(() =>
      expect(applyTemplateMock).toHaveBeenCalledWith("template-1", {
        project_id: "project-1",
        bindings: { input_layer: "layer-uuid-1" },
      })
    );
  });

  it("calls onDone with the result after a successful apply", async () => {
    const onDone = vi.fn();
    render(
      <UseTemplateFlow
        template={baseTemplate}
        context={{ kind: "in_project", projectId: "project-1" }}
        onClose={noop}
        onDone={onDone}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "add_to_project" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(useResult));
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("refreshes the content feed and revalidates onboarding facts after a successful apply", async () => {
    render(
      <UseTemplateFlow
        template={baseTemplate}
        context={{ kind: "in_project", projectId: "project-1" }}
        onClose={noop}
        onDone={noop}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "add_to_project" }));

    await waitFor(() => expect(refreshContentFeedMock).toHaveBeenCalled());
    expect(swrMutateMock).toHaveBeenCalledWith(`${USERS_API_BASE_URL}/me/onboarding`);
  });

  it("shows a toast with the unresolved input count after a successful apply", async () => {
    applyTemplateMock.mockReset().mockResolvedValue({
      ...useResult,
      unresolved_inputs: [askInput, { ...askInput, key: "input_layer_2" }],
    });

    render(
      <UseTemplateFlow
        template={baseTemplate}
        context={{ kind: "in_project", projectId: "project-1" }}
        onClose={noop}
        onDone={noop}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "add_to_project" }));

    await waitFor(() =>
      expect(toastInfoMock).toHaveBeenCalledWith(`unresolved_input_count:${JSON.stringify({ count: 2 })}`)
    );
  });

  it("shows an error with role=alert and does not call onDone when apply rejects (e.g. a 409)", async () => {
    applyTemplateMock.mockReset().mockRejectedValue(new Error("Failed to use template"));
    const onDone = vi.fn();
    render(
      <UseTemplateFlow
        template={baseTemplate}
        context={{ kind: "in_project", projectId: "project-1" }}
        onClose={noop}
        onDone={onDone}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "add_to_project" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Failed to use template"));
    expect(onDone).not.toHaveBeenCalled();
  });

  it("says why an ask slot has no picker when the project holds no fitting layer", () => {
    useProjectLayersMock.mockReturnValue({
      layers: [
        {
          id: 1,
          layer_id: "layer-uuid-9",
          name: "Districts",
          type: "feature",
          feature_layer_geometry_type: "polygon",
        },
      ],
      isLoading: false,
      isError: undefined,
    });
    render(
      <UseTemplateFlow
        template={templateWithAsk}
        context={{ kind: "in_project", projectId: "project-1" }}
        onClose={noop}
        onDone={noop}
      />
    );

    expect(screen.getByText("no_matching_layer")).toBeInTheDocument();
    expect(screen.getByText("template_open_slots_hint")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("lists a shipped input on its own step, with nothing to bind", () => {
    const shipped: TemplateInput = {
      ...askInput,
      key: "shipped",
      label: "Stops",
      mode: "ship",
      layer_id: "layer-1",
    };
    render(
      <UseTemplateFlow
        template={{ ...baseTemplate, inputs: [shipped] }}
        context={{ kind: "in_project", projectId: "project-1" }}
        onClose={noop}
        onDone={noop}
      />
    );

    expect(screen.getByText("Stops")).toBeInTheDocument();
    expect(screen.getByText("ships_with_template")).toBeInTheDocument();
    expect(screen.queryByText("decide_later")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "add_to_project" })).toBeInTheDocument();
  });

  describe("outside a project", () => {
    const projects = [projectRow("project-a", "Alpha"), projectRow("project-b", "Beta")];

    it("offers adding to a project first and preselects the last-opened one", async () => {
      useContentMock.mockReturnValue(projectPage(projects));
      render(
        <UseTemplateFlow
          template={baseTemplate}
          context={{ kind: "outside_project" }}
          onClose={noop}
          onDone={noop}
        />
      );

      await expect(screen.getByRole("button", { name: "add_to_a_project" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await expect(screen.getByRole("radio", { name: "Alpha" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByText("last_opened")).toBeInTheDocument();
      expect(screen.queryByLabelText("name")).not.toBeInTheDocument();
    });

    it("applies with the chosen project's id and labels the button Add to project", async () => {
      useContentMock.mockReturnValue(projectPage(projects));
      render(
        <UseTemplateFlow
          template={baseTemplate}
          context={{ kind: "outside_project" }}
          onClose={noop}
          onDone={noop}
        />
      );

      fireEvent.click(screen.getByRole("radio", { name: "Beta" }));
      fireEvent.click(screen.getByRole("button", { name: "add_to_project" }));

      await waitFor(() =>
        expect(applyTemplateMock).toHaveBeenCalledWith("template-1", {
          project_id: "project-b",
          bindings: {},
        })
      );
    });

    it("offers the chosen project's layers on the bindings step", () => {
      useContentMock.mockReturnValue(projectPage(projects));
      useProjectLayersMock.mockImplementation((projectId?: string) => ({
        layers:
          projectId === "project-a"
            ? [
                {
                  id: 1,
                  layer_id: "layer-uuid-1",
                  name: "Roads",
                  type: "feature",
                  feature_layer_geometry_type: "point",
                },
              ]
            : [],
        isLoading: false,
        isError: undefined,
      }));
      render(
        <UseTemplateFlow
          template={templateWithAsk}
          context={{ kind: "outside_project" }}
          onClose={noop}
          onDone={noop}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "next_step" }));

      expect(within(openPicker(askInput.key)).getByRole("option", { name: "Roads" })).toBeInTheDocument();
      expect(
        screen.getByText(`template_inputs_from_project:${JSON.stringify({ project: "Alpha" })}`)
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          `template_adds_to_project:${JSON.stringify({ name: "Isochrone starter", project: "Alpha" })}`
        )
      ).toBeInTheDocument();
    });

    it("switches to the new-project form and creates with a folder", async () => {
      useContentMock.mockReturnValue(projectPage(projects));
      render(
        <UseTemplateFlow
          template={baseTemplate}
          context={{ kind: "outside_project" }}
          onClose={noop}
          onDone={noop}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "create_a_new_project" }));
      expect(screen.getByText("location")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "create" }));

      await waitFor(() =>
        expect(applyTemplateMock).toHaveBeenCalledWith("template-1", {
          target_folder_id: "folder-home",
          name: "Isochrone starter",
          bindings: {},
        })
      );
    });

    it("does not preselect or allow a project the caller can only view", async () => {
      useContentMock.mockReturnValue(
        projectPage([
          projectRow("project-v", "Viewed", "viewer"),
          projectRow("project-e", "Edited", "editor"),
        ])
      );
      render(
        <UseTemplateFlow
          template={baseTemplate}
          context={{ kind: "outside_project" }}
          onClose={noop}
          onDone={noop}
        />
      );

      await expect(screen.getByRole("radio", { name: "Viewed" })).toBeDisabled();
      expect(screen.getByText("view_only")).toBeInTheDocument();
      await expect(screen.getByRole("radio", { name: "Edited" })).toHaveAttribute("aria-checked", "true");
    });

    it("shows neither half of the location step until the project list has answered", async () => {
      useContentMock.mockReturnValue({ page: undefined, isLoading: true, isError: undefined });
      render(
        <UseTemplateFlow
          template={baseTemplate}
          context={{ kind: "outside_project" }}
          onClose={noop}
          onDone={noop}
        />
      );

      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(screen.queryByLabelText("name")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "add_to_a_project" })).not.toBeInTheDocument();
      await expect(screen.getByRole("button", { name: "create" })).toBeDisabled();
    });

    it("goes straight to the new-project form when the caller has no projects", () => {
      render(
        <UseTemplateFlow
          template={baseTemplate}
          context={{ kind: "outside_project" }}
          onClose={noop}
          onDone={noop}
        />
      );

      expect(screen.queryByRole("button", { name: "add_to_a_project" })).not.toBeInTheDocument();
      expect(screen.getByText("no_projects_yet_template")).toBeInTheDocument();
      expect(screen.getByLabelText("name")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "create" })).toBeInTheDocument();
    });

    it("never offers an existing project for a project template", () => {
      useContentMock.mockReturnValue(projectPage(projects));
      render(
        <UseTemplateFlow
          template={{ ...baseTemplate, payload_kind: "project", kinds: [] }}
          context={{ kind: "outside_project" }}
          onClose={noop}
          onDone={noop}
        />
      );

      expect(useContentMock).toHaveBeenCalledWith(null);
      expect(screen.queryByRole("button", { name: "add_to_a_project" })).not.toBeInTheDocument();
      expect(screen.queryByText("no_projects_yet_template")).not.toBeInTheDocument();
      expect(screen.getByLabelText("name")).toBeInTheDocument();
    });
  });
});
