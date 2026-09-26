import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Space } from "@/lib/validations/content";
import type { Folder } from "@/lib/validations/folder";
import type { Project } from "@/lib/validations/project";

import ProjectShareDialog from "@/components/modals/content/ProjectShareDialog";

const { shareDialogMock, useSpacesMock, useFoldersMock } = vi.hoisted(() => ({
  shareDialogMock: vi.fn(),
  useSpacesMock: vi.fn(),
  useFoldersMock: vi.fn(),
}));

vi.mock("@/lib/api/content", () => ({ useSpaces: useSpacesMock }));
vi.mock("@/lib/api/folders", () => ({ useFolders: useFoldersMock }));
vi.mock("@/components/modals/content/ShareDialog", () => ({
  default: (props: unknown) => {
    shareDialogMock(props);
    return null;
  },
}));

const teamSpace: Space = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "team",
  name: "Planning",
  default_role: "editor",
  my_role: "owner",
  team_id: "22222222-2222-4222-8222-222222222222",
  organization_id: null,
};

const folders = [{ id: "folder-1", name: "Mobility" }] as unknown as Folder[];

const project = (overrides: Partial<Project> = {}): Project =>
  ({
    id: "33333333-3333-4333-8333-333333333333",
    name: "Bus stops",
    folder_id: "folder-1",
    space_id: teamSpace.id,
    space_kind: "team",
    space_name: "Planning",
    my_role: "project-owner",
    restricted: true,
    restricted_inherited: false,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    ...overrides,
  }) as unknown as Project;

const lastProps = () => shareDialogMock.mock.calls.at(-1)?.[0];

describe("ProjectShareDialog", () => {
  beforeEach(() => {
    shareDialogMock.mockReset();
    useSpacesMock.mockReturnValue({ spaces: [teamSpace] });
    useFoldersMock.mockReturnValue({ folders });
  });

  it("opens the Content share dialog for the project as an owned project row", () => {
    render(<ProjectShareDialog project={project()} onClose={vi.fn()} />);

    expect(lastProps().item).toMatchObject({
      type: "project",
      id: "33333333-3333-4333-8333-333333333333",
      name: "Bus stops",
      folder_id: "folder-1",
      space_id: teamSpace.id,
      my_role: "owner",
      restricted: true,
      restricted_inherited: false,
      is_shortcut: false,
    });
    expect(lastProps().space).toBe(teamSpace);
    expect(lastProps().folders).toBe(folders);
  });

  it("carries an editor's role across without the resource prefix", () => {
    render(<ProjectShareDialog project={project({ my_role: "project-editor" })} onClose={vi.fn()} />);

    expect(lastProps().item.my_role).toBe("editor");
  });

  it("describes the project's space from the project when it is not one of the caller's spaces", () => {
    useSpacesMock.mockReturnValue({ spaces: [] });

    render(<ProjectShareDialog project={project()} onClose={vi.fn()} />);

    expect(lastProps().space).toMatchObject({ id: teamSpace.id, kind: "team", name: "Planning" });
  });
});
