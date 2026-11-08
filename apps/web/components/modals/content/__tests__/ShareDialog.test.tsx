import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ContentItem, Space } from "@/lib/validations/content";

import ShareDialog from "@/components/modals/content/ShareDialog";

const {
  FOLDERS_TEST_BASE_URL,
  BUNDLES_TEST_BASE_URL,
  useItemSharesMock,
  mutateItemSharesMock,
  shareProjectMock,
  shareLayerMock,
  useTeamsMock,
  useOrganizationMock,
  useOrganizationMembersMock,
  useProjectLayersMock,
  useProjectMock,
  useFolderGrantsMock,
  useBundleGrantsMock,
  shareFolderGrantMock,
  deleteFolderGrantMock,
  shareBundleGrantMock,
  deleteBundleGrantMock,
  useTemplateGrantsMock,
  useTemplateMock,
  mutateTemplateGrantsMock,
  addTemplateGrantMock,
  deleteTemplateGrantMock,
  refreshTemplatesMock,
  refreshContentFeedMock,
  setRestrictedMock,
  mutateMock,
  toastSuccessMock,
  toastErrorMock,
} = vi.hoisted(() => ({
  FOLDERS_TEST_BASE_URL: "http://test/api/v2/folder",
  BUNDLES_TEST_BASE_URL: "http://test/api/v2/bundles",
  useItemSharesMock: vi.fn(),
  mutateItemSharesMock: vi.fn(),
  shareProjectMock: vi.fn(),
  shareLayerMock: vi.fn(),
  useTeamsMock: vi.fn(),
  useOrganizationMock: vi.fn(),
  useOrganizationMembersMock: vi.fn(),
  useProjectLayersMock: vi.fn(),
  useProjectMock: vi.fn(),
  useFolderGrantsMock: vi.fn(),
  useBundleGrantsMock: vi.fn(),
  shareFolderGrantMock: vi.fn(),
  deleteFolderGrantMock: vi.fn(),
  shareBundleGrantMock: vi.fn(),
  deleteBundleGrantMock: vi.fn(),
  useTemplateGrantsMock: vi.fn(),
  useTemplateMock: vi.fn(),
  mutateTemplateGrantsMock: vi.fn(),
  addTemplateGrantMock: vi.fn(),
  deleteTemplateGrantMock: vi.fn(),
  refreshTemplatesMock: vi.fn(),
  refreshContentFeedMock: vi.fn(),
  setRestrictedMock: vi.fn(),
  mutateMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => <span>{i18nKey}</span>,
}));
vi.mock("react-toastify", () => ({ toast: { success: toastSuccessMock, error: toastErrorMock } }));
vi.mock("swr", () => ({ mutate: mutateMock }));
vi.mock("@/lib/api/content", () => ({
  refreshContentFeed: refreshContentFeedMock,
  setRestricted: setRestrictedMock,
}));
vi.mock("@/lib/api/share", () => ({
  useItemShares: useItemSharesMock,
  shareProject: shareProjectMock,
  shareLayer: shareLayerMock,
}));
vi.mock("@/lib/api/teams", () => ({ useTeams: useTeamsMock }));
vi.mock("@/lib/api/users", () => ({ useOrganization: useOrganizationMock }));
vi.mock("@/lib/api/organizations", () => ({ useOrganizationMembers: useOrganizationMembersMock }));
vi.mock("@/lib/api/projects", () => ({
  useProjectLayers: useProjectLayersMock,
  useProject: useProjectMock,
}));
vi.mock("@/lib/api/folders", () => ({
  FOLDERS_API_BASE_URL: FOLDERS_TEST_BASE_URL,
  useFolderGrants: useFolderGrantsMock,
  shareFolderGrant: shareFolderGrantMock,
  deleteFolderGrant: deleteFolderGrantMock,
}));
vi.mock("@/lib/api/bundles", () => ({
  BUNDLES_API_BASE_URL: BUNDLES_TEST_BASE_URL,
  useBundleGrants: useBundleGrantsMock,
  shareBundleGrant: shareBundleGrantMock,
  deleteBundleGrant: deleteBundleGrantMock,
}));
vi.mock("@/lib/api/templates", () => ({
  useTemplate: useTemplateMock,
  useTemplateGrants: useTemplateGrantsMock,
  addTemplateGrant: addTemplateGrantMock,
  deleteTemplateGrant: deleteTemplateGrantMock,
  refreshTemplates: refreshTemplatesMock,
}));
vi.mock("@/components/modals/share/ShareWithPublicTab", () => ({ default: () => null }));

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

const layerItem: ContentItem = {
  type: "layer",
  id: "layer-1",
  name: "Layer A",
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

const folderItem: ContentItem = {
  type: "folder",
  id: "folder-1",
  name: "Folder A",
  space_id: "space-personal",
  folder_id: null,
  updated_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  my_role: "owner",
  shared_with: null,
  restricted: false,
  restricted_inherited: false,
  is_shortcut: false,
  is_public: false,
};

const templateItem: ContentItem = {
  type: "template",
  id: "tmpl-1",
  name: "Template A",
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

const members = [
  {
    id: "u1",
    firstname: "Lena",
    lastname: "Fischer",
    email: "lena@acme.test",
    roles: [],
    invitation_status: "accepted",
    avatar: "",
  },
  {
    id: "u2",
    firstname: "Bob",
    lastname: "Owens",
    email: "bob@acme.test",
    roles: [],
    invitation_status: "accepted",
    avatar: "",
  },
  {
    id: "u3",
    firstname: "Carla",
    lastname: "Nunez",
    email: "carla@acme.test",
    roles: [],
    invitation_status: "accepted",
    avatar: "",
  },
];

const teams = [
  { id: "team-1", name: "Design Team", avatar: null, role: "team-editor" },
  { id: "team-2", name: "Marketing", avatar: null, role: "team-viewer" },
];

const noop = () => {};

describe("ShareDialog", () => {
  beforeEach(() => {
    mutateItemSharesMock.mockReset().mockResolvedValue(undefined);
    useItemSharesMock.mockReset().mockReturnValue({
      shares: { teams: [], organizations: [], users: [] },
      mutate: mutateItemSharesMock,
    });
    shareProjectMock.mockReset().mockResolvedValue(undefined);
    shareLayerMock.mockReset().mockResolvedValue(undefined);
    useTeamsMock.mockReset().mockReturnValue({ teams });
    useOrganizationMock.mockReset().mockReturnValue({ organization: { id: "org-1", name: "Acme" } });
    useOrganizationMembersMock.mockReset().mockReturnValue({ members });
    useProjectLayersMock.mockReset().mockReturnValue({ layers: [{ id: "l1" }, { id: "l2" }] });
    useProjectMock.mockReset().mockReturnValue({ project: undefined });
    useFolderGrantsMock.mockReset().mockReturnValue({ data: undefined });
    useBundleGrantsMock.mockReset().mockReturnValue({ data: undefined });
    shareFolderGrantMock.mockReset();
    deleteFolderGrantMock.mockReset();
    shareBundleGrantMock.mockReset();
    deleteBundleGrantMock.mockReset();
    mutateTemplateGrantsMock.mockReset().mockResolvedValue(undefined);
    useTemplateMock.mockReset().mockReturnValue({ template: undefined, isLoading: false });
    useTemplateGrantsMock.mockReset().mockReturnValue({
      grants: [],
      isLoading: false,
      mutate: mutateTemplateGrantsMock,
    });
    addTemplateGrantMock.mockReset().mockResolvedValue(undefined);
    deleteTemplateGrantMock.mockReset().mockResolvedValue(undefined);
    refreshTemplatesMock.mockReset();
    refreshContentFeedMock.mockReset();
    setRestrictedMock.mockReset().mockResolvedValue(undefined);
    mutateMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("adds a person by search, shows the transfer row in a personal space, and saves the new share", async () => {
    const onTransfer = vi.fn();
    render(
      <ShareDialog
        item={projectItem}
        space={personalSpace}
        folders={[]}
        onClose={noop}
        onTransfer={onTransfer}
      />
    );
    // Named by its title, as every AppDialog is.
    expect(screen.getByRole("dialog", { name: /^share_item/ })).toBeInTheDocument();

    const search = screen.getByPlaceholderText("add_people_placeholder");
    fireEvent.change(search, { target: { value: "len" } });

    expect(screen.getByText("Lena Fischer")).toBeInTheDocument();
    expect(screen.queryByText("Bob Owens")).not.toBeInTheDocument();
    expect(screen.queryByText("Carla Nunez")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Lena Fischer"));

    // The newly added row renders a RolePicker defaulted to viewer.
    expect(screen.getByText("viewer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "teams" }));
    expect(screen.getByText("transfer_ownership")).toBeInTheDocument();

    fireEvent.click(screen.getByText("done"));

    await waitFor(() =>
      expect(shareProjectMock).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ users: [{ id: "u1", role: "project-viewer" }] })
      )
    );
  });

  it("keeps Done disabled until the item's own grants have loaded", async () => {
    // The layer/project save sends all three grantee families whole, and the
    // backend reads a present-but-empty family as "clear it" — so Done before
    // the grants arrive would delete every one of them.
    useItemSharesMock.mockReturnValue({ shares: undefined, mutate: mutateItemSharesMock });
    const { rerender } = render(
      <ShareDialog item={projectItem} space={personalSpace} folders={[]} onClose={noop} />
    );

    const done = screen.getByRole("button", { name: /done/ });
    expect(done).toHaveProperty("disabled", true);
    fireEvent.click(done);
    expect(shareProjectMock).not.toHaveBeenCalled();

    useItemSharesMock.mockReturnValue({
      shares: { teams: [], organizations: [], users: [{ id: "u1", role: "project-viewer" }] },
      mutate: mutateItemSharesMock,
    });
    rerender(<ShareDialog item={projectItem} space={personalSpace} folders={[]} onClose={noop} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /done/ })).toHaveProperty("disabled", false)
    );
    fireEvent.click(screen.getByRole("button", { name: /done/ }));

    // The grants that were there are saved back, rather than being cleared.
    await waitFor(() =>
      expect(shareProjectMock).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ users: [{ id: "u1", role: "project-viewer" }] })
      )
    );
  });

  it("keeps Done disabled when the grant read failed, since an empty list is not 'no grants'", () => {
    useItemSharesMock.mockReturnValue({
      shares: undefined,
      isError: new Error("500"),
      mutate: mutateItemSharesMock,
    });
    render(<ShareDialog item={layerItem} space={personalSpace} folders={[]} onClose={noop} />);

    const done = screen.getByRole("button", { name: /done/ });
    expect(done).toHaveProperty("disabled", true);
    fireEvent.click(done);
    expect(shareLayerMock).not.toHaveBeenCalled();
  });

  it("hides the transfer row in a team space", () => {
    const onTransfer = vi.fn();
    render(
      <ShareDialog item={projectItem} space={teamSpace} folders={[]} onClose={noop} onTransfer={onTransfer} />
    );

    fireEvent.click(screen.getByRole("tab", { name: "teams" }));

    expect(screen.queryByText("transfer_ownership")).not.toBeInTheDocument();
  });

  it("shows the not-supported message on the People tab for a folder", () => {
    render(<ShareDialog item={folderItem} space={personalSpace} folders={[]} onClose={noop} />);

    expect(screen.getByText("people_not_supported_for_type")).toBeInTheDocument();
  });

  it("invalidates the project's own share cache after saving", async () => {
    render(<ShareDialog item={projectItem} space={personalSpace} folders={[]} onClose={noop} />);

    fireEvent.click(screen.getByText("done"));

    await waitFor(() => expect(shareProjectMock).toHaveBeenCalled());
    // `refreshContentFeed` only matches the content-feed keys, so the
    // layer/project share key has to be invalidated on its own — otherwise a
    // reopened dialog seeds from the pre-save grants.
    expect(mutateItemSharesMock).toHaveBeenCalled();
  });

  it("invalidates the folder's grant cache after saving", async () => {
    useFolderGrantsMock.mockReturnValue({
      data: { grants: [{ grantee_type: "team", grantee_id: "team-2", role: "folder-viewer" }] },
    });
    render(<ShareDialog item={folderItem} space={personalSpace} folders={[]} onClose={noop} />);

    fireEvent.click(screen.getByText("done"));

    await waitFor(() => expect(refreshContentFeedMock).toHaveBeenCalled());

    expect(mutateMock).toHaveBeenCalledTimes(1);
    const filter = mutateMock.mock.calls[0][0] as (key: unknown) => boolean;
    expect(filter(`${FOLDERS_TEST_BASE_URL}/folder-1/share`)).toBe(true);
    expect(filter(`${BUNDLES_TEST_BASE_URL}/bundle-1/share`)).toBe(false);
  });

  it("shows the restricted switch for an owner and toggles it immediately", async () => {
    render(<ShareDialog item={layerItem} space={teamSpace} folders={[]} onClose={noop} />);

    const toggle = screen.getByRole("checkbox", { name: "restricted" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);

    fireEvent.click(toggle);

    await waitFor(() => expect(setRestrictedMock).toHaveBeenCalledWith("layer", "layer-1", true));
    expect(toastSuccessMock).toHaveBeenCalledWith("restricted_updated");
    expect(refreshContentFeedMock).toHaveBeenCalled();
  });

  it("hides the restricted switch in a personal space, where it would be a no-op", () => {
    render(<ShareDialog item={layerItem} space={personalSpace} folders={[]} onClose={noop} />);

    expect(screen.queryByRole("checkbox", { name: "restricted" })).not.toBeInTheDocument();
  });

  it("hides the restricted switch for a non-owner", () => {
    render(
      <ShareDialog item={{ ...layerItem, my_role: "viewer" }} space={teamSpace} folders={[]} onClose={noop} />
    );

    expect(screen.queryByRole("checkbox", { name: "restricted" })).not.toBeInTheDocument();
  });

  it("hides the restricted switch for a shortcut, even when my_role says owner", () => {
    render(
      <ShareDialog item={{ ...layerItem, is_shortcut: true }} space={teamSpace} folders={[]} onClose={noop} />
    );

    expect(screen.queryByRole("checkbox", { name: "restricted" })).not.toBeInTheDocument();
  });

  it("disables the restricted switch and shows the inherited note when inherited", () => {
    render(
      <ShareDialog
        item={{ ...layerItem, restricted_inherited: true }}
        space={teamSpace}
        folders={[]}
        onClose={noop}
      />
    );

    const toggle = screen.getByRole("checkbox", { name: "restricted" }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText("common:restricted_inherited_note")).toBeInTheDocument();
  });

  it("reverts the switch and toasts an error when the update fails", async () => {
    setRestrictedMock.mockReset().mockRejectedValueOnce(new Error("nope"));
    render(<ShareDialog item={layerItem} space={teamSpace} folders={[]} onClose={noop} />);

    const toggle = screen.getByRole("checkbox", { name: "restricted" }) as HTMLInputElement;
    fireEvent.click(toggle);

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("error_updating_restricted"));
    expect(toggle.checked).toBe(false);
  });

  describe("template branch", () => {
    it("supports the People tab for a template, unlike a folder", () => {
      render(<ShareDialog item={templateItem} space={personalSpace} folders={[]} onClose={noop} />);

      expect(screen.queryByText("people_not_supported_for_type")).not.toBeInTheDocument();
    });

    it("says the shipped datasets are not shared along with the template", () => {
      useTemplateMock.mockReturnValue({
        template: {
          inputs: [
            { key: "k1", label: "Parks", mode: "ship", layer_id: "L1", from_catalog: false },
            { key: "k2", label: "Trees", mode: "ship", layer_id: "L2", from_catalog: false },
            // Catalog data is readable by everyone, and an ask slot ships
            // nothing — neither counts.
            { key: "k3", label: "Buildings", mode: "ship", layer_id: "L3", from_catalog: true },
            { key: "k4", label: "Ask", mode: "ask", layer_id: null, from_catalog: false },
          ],
        },
        isLoading: false,
      });

      render(<ShareDialog item={templateItem} space={personalSpace} folders={[]} onClose={noop} />);

      expect(screen.getByText('template_shares_datasets_note:{"count":2}')).toBeInTheDocument();
    });

    it("says nothing about datasets when the template ships none", () => {
      useTemplateMock.mockReturnValue({
        template: { inputs: [{ key: "k1", label: "Ask", mode: "ask", layer_id: null, from_catalog: false }] },
        isLoading: false,
      });

      render(<ShareDialog item={templateItem} space={personalSpace} folders={[]} onClose={noop} />);

      expect(screen.queryByText(/template_shares_datasets_note/)).not.toBeInTheDocument();
    });

    it("has no Public tab for a template", () => {
      render(<ShareDialog item={templateItem} space={personalSpace} folders={[]} onClose={noop} />);

      expect(screen.queryByRole("tab", { name: "public" })).not.toBeInTheDocument();
    });

    it("seeds people, teams and organizations from the template's own grant list", () => {
      useTemplateGrantsMock.mockReturnValue({
        grants: [
          {
            id: "grant-1",
            grantee_type: "user",
            grantee_id: "u1",
            grantee_name: "Lena Fischer",
            role: "template-viewer",
            granted_by: null,
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "grant-2",
            grantee_type: "team",
            grantee_id: "team-2",
            grantee_name: "Marketing",
            role: "template-editor",
            granted_by: null,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        isLoading: false,
        mutate: mutateTemplateGrantsMock,
      });
      render(<ShareDialog item={templateItem} space={personalSpace} folders={[]} onClose={noop} />);

      expect(screen.getByText("Lena Fischer")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("tab", { name: "teams" }));
      expect(screen.getByText("Marketing")).toBeInTheDocument();
      expect(screen.getByText("editor")).toBeInTheDocument();
    });

    it("adds a new grant on save with the template-prefixed role", async () => {
      render(<ShareDialog item={templateItem} space={personalSpace} folders={[]} onClose={noop} />);

      const search = screen.getByPlaceholderText("add_people_placeholder");
      fireEvent.change(search, { target: { value: "len" } });
      fireEvent.click(screen.getByText("Lena Fischer"));

      fireEvent.click(screen.getByText("done"));

      await waitFor(() =>
        expect(addTemplateGrantMock).toHaveBeenCalledWith("tmpl-1", {
          grantee_type: "user",
          grantee_id: "u1",
          role: "template-viewer",
        })
      );
      expect(refreshTemplatesMock).toHaveBeenCalled();
      expect(mutateTemplateGrantsMock).toHaveBeenCalled();
    });

    it("deletes a removed grant by its own grant id, not the grantee id", async () => {
      useTemplateGrantsMock.mockReturnValue({
        grants: [
          {
            id: "grant-9",
            grantee_type: "team",
            grantee_id: "team-2",
            grantee_name: "Marketing",
            role: "template-viewer",
            granted_by: null,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        isLoading: false,
        mutate: mutateTemplateGrantsMock,
      });
      render(<ShareDialog item={templateItem} space={personalSpace} folders={[]} onClose={noop} />);

      fireEvent.click(screen.getByRole("tab", { name: "teams" }));
      // Team-2 (Marketing) is the only row with an existing grant — its
      // RolePicker button is the sole "viewer" text on screen before its
      // menu opens (team-1 has no grant, so its button reads "no_access").
      fireEvent.click(screen.getByText("viewer"));
      fireEvent.click(within(screen.getByRole("menu")).getByText("no_access"));

      fireEvent.click(screen.getByText("done"));

      await waitFor(() => expect(deleteTemplateGrantMock).toHaveBeenCalledWith("tmpl-1", "grant-9"));
      expect(addTemplateGrantMock).not.toHaveBeenCalled();
    });
  });
});
