import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useHomeCreate } from "@/hooks/dashboard/home/useHomeCreate";

const { createProjectMock, pushMock, refreshContentFeedMock, mutateMock } = vi.hoisted(() => ({
  createProjectMock: vi.fn(),
  pushMock: vi.fn(),
  refreshContentFeedMock: vi.fn(),
  mutateMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("swr", () => ({ mutate: mutateMock }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock("@/lib/api/content", () => ({
  refreshContentFeed: refreshContentFeedMock,
  useSpaces: () => ({ spaces: [{ id: "space-1", kind: "personal" }] }),
}));
vi.mock("@/lib/api/folders", () => ({
  useFolders: () => ({ folders: [{ id: "home-1", parent_id: null }] }),
}));
vi.mock("@/lib/api/users", () => ({ USERS_API_BASE_URL: "http://core/api/v2/users" }));
vi.mock("@/lib/api/projects", () => ({
  createProject: (payload: unknown) => createProjectMock(payload),
}));
vi.mock("@/lib/utils/content", () => ({ homeFolderOf: () => ({ id: "home-1" }) }));
vi.mock("@/components/dashboard/common/NameDialog", () => ({
  default: (props: { onSubmit: (name: string) => Promise<void> }) => (
    <button onClick={() => props.onSubmit("Bus stops")}>submit-project</button>
  ),
}));
// The other two project starts belong to `NewProjectFlows`; only the blank
// one is reachable from this hook.
vi.mock("@/components/templates/TemplateBrowser", () => ({ default: () => null }));
vi.mock("@/components/templates/UseTemplateFlow", () => ({ default: () => null }));
vi.mock("@/components/modals/ProjectImport", () => ({ default: () => null }));
vi.mock("@/hooks/templates/useUseTemplate", () => ({ templateResultHref: () => "/map/p-1" }));
vi.mock("@/components/addLayer/AddLayerDialog", () => ({
  default: (props: { onClose: () => void }) => <button onClick={props.onClose}>close-upload</button>,
}));

const Harness = () => {
  const { newProject, addDataset, dialogs } = useHomeCreate();
  return (
    <>
      <button onClick={newProject}>open-project</button>
      <button onClick={addDataset}>open-upload</button>
      {dialogs}
    </>
  );
};

describe("useHomeCreate", () => {
  beforeEach(() => {
    createProjectMock.mockReset().mockResolvedValue({ id: "p-1" });
    pushMock.mockReset();
    refreshContentFeedMock.mockReset();
    mutateMock.mockReset();
  });

  it("revalidates the onboarding facts after a project is created", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByText("open-project"));
    fireEvent.click(screen.getByText("submit-project"));

    await waitFor(() => expect(createProjectMock).toHaveBeenCalled());
    expect(mutateMock).toHaveBeenCalledWith("http://core/api/v2/users/me/onboarding");
  });

  it("revalidates the onboarding facts after the upload dialog closes", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByText("open-upload"));
    // The dialog is a lazy `next/dynamic` chunk, so it lands a tick later.
    fireEvent.click(await screen.findByText("close-upload"));

    expect(mutateMock).toHaveBeenCalledWith("http://core/api/v2/users/me/onboarding");
  });
});
