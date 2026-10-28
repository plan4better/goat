import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/validations/project";

import ShareWithPublicTab from "@/components/modals/share/ShareWithPublicTab";

const api = vi.hoisted(() => ({
  unpublished: [] as Array<{ layer_project_id: number; reason: string }>,
  mutateMap: vi.fn(async () => undefined),
  publishProject: vi.fn(async () => undefined),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
  Trans: () => null,
}));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));
vi.mock("@/lib/api/customDomains", () => ({
  useOrganizationDomains: () => ({ domains: [], mutate: vi.fn() }),
  assignDomainToProject: vi.fn(),
  unassignDomainFromProject: vi.fn(),
}));
vi.mock("@/lib/api/organizationAnalytics", () => ({
  useOrganizationAnalytics: () => ({ analyticsList: [], mutate: vi.fn() }),
  setProjectAnalytics: vi.fn(),
  setProjectTrackingRequireConsent: vi.fn(),
}));
vi.mock("@/lib/api/users", () => ({ useOrganization: () => ({ organization: { id: "org" } }) }));
vi.mock("@/lib/api/projects", () => ({
  usePublicProject: () => ({
    sharedProject: { updated_at: new Date().toISOString(), custom_domain_id: null, analytics_id: null },
    isLoading: false,
    mutate: vi.fn(async () => undefined),
  }),
  useProjectLayers: () => ({
    layers: [
      { id: 5, name: "Districts" },
      { id: 6, name: "Trees" },
      { id: 7, name: "Roads" },
    ],
  }),
  publishProject: api.publishProject,
  unpublishProject: vi.fn(),
}));
vi.mock("@/lib/api/map", () => ({
  useProjectMap: () => ({ map: { unpublished: api.unpublished }, mutate: api.mutateMap }),
}));

const project = { id: "p1", name: "Demo" } as Project;

describe("the publish tab", () => {
  beforeEach(() => {
    api.unpublished = [];
    api.mutateMap.mockClear();
  });

  it("the publish tab names the layers with unpublished changes", async () => {
    api.unpublished = [
      { layer_project_id: 5, reason: "edited" },
      { layer_project_id: 6, reason: "recomputed" },
    ];
    render(<ShareWithPublicTab project={project} />);
    expect(screen.getByText("unpublished_changes")).toBeInTheDocument();
    expect(screen.getByText('unpublished_reason_edited {"name":"Districts"}')).toBeInTheDocument();
    expect(screen.getByText('unpublished_reason_recomputed {"name":"Trees"}')).toBeInTheDocument();
    expect(screen.queryByText(/Roads/)).toBeNull();
    // Republishing answers the note: the map request is asked again.
    await userEvent.click(screen.getByRole("button", { name: "republish" }));
    expect(api.publishProject).toHaveBeenCalledWith("p1");
    expect(api.mutateMap).toHaveBeenCalled();
  });

  it("no note when the published map is current", () => {
    render(<ShareWithPublicTab project={project} />);
    expect(screen.queryByText("unpublished_changes")).toBeNull();
  });
});
