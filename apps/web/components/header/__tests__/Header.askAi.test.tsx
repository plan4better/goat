import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAssistantStore, setDockState } from "@/lib/assistant/store";

import Header from "@/components/header/Header";

// The real header and Ask AI button; what the header's other items fetch or open is stubbed.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  Trans: () => null,
}));
vi.mock("react-map-gl/maplibre", () => ({ useMap: () => ({ map: undefined }) }));
const { org } = vi.hoisted(() => ({
  org: { organization: undefined as { on_trial: boolean; plan_renewal_date: string } | undefined },
}));
vi.mock("@/lib/api/users", () => ({
  // Trials show only where billing is on.
  useFeatures: () => ({ features: { billing: true } }),
  useOrganization: () => org,
  useUserProfile: () => ({ userProfile: { id: "u1" } }),
}));
const { authz } = vi.hoisted(() => ({ authz: { isOrgAdmin: false } }));
vi.mock("@/hooks/auth/AuthZ", () => ({ useAuthZ: () => authz }));
vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: (select: (state: unknown) => unknown) => select({ map: { mapMode: "data" } }),
}));
vi.mock("@/components/UserInfoMenu", () => ({ default: () => null }));
vi.mock("@/components/support/SupportMenu", () => ({ default: () => null }));
vi.mock("@/components/header/OnboardingTray", () => ({ default: () => null }));
vi.mock("@/components/header/StatusDot", () => ({ default: () => null }));
vi.mock("@/components/header/WhatsNewPopper", () => ({ default: () => null }));
vi.mock("@/components/jobs/JobsPopper", () => ({ default: () => null }));
vi.mock("@/components/modals/ContentDelete", () => ({ default: () => null }));
vi.mock("@/components/modals/Metadata", () => ({ default: () => null }));
vi.mock("@/components/modals/content/ProjectShareDialog", () => ({ default: () => null }));
vi.mock("@/components/templates/SaveTemplateDialog", () => ({ default: () => null }));

/** A viewport below or above MUI's `md` breakpoint, as `useMediaQuery` reads it. */
function viewport(narrow: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: narrow && query.includes("max-width"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
}

const original = window.matchMedia;

beforeEach(() => {
  authz.isOrgAdmin = false;
  org.organization = undefined;
  window.sessionStorage.clear();
  resetAssistantStore();
  setDockState({ enabled: true });
});
afterEach(() => {
  window.matchMedia = original;
});

describe("Header Ask AI button", () => {
  it("shows the icon alone in the workspace header below md", () => {
    viewport(true);
    render(<Header title="GOAT" />);
    const button = screen.getByRole("button", { name: "assistant_ask_ai" });
    expect(button.className).toContain("MuiIconButton-root");
    expect(button.textContent).toBe("");
  });

  it("shows the labelled button in the workspace header from md up", () => {
    viewport(false);
    render(<Header title="GOAT" />);
    const button = screen.getByRole("button", { name: "assistant_ask_ai" });
    expect(button.className).toContain("MuiButton-root");
    expect(button.textContent).toBe("assistant_ask_ai");
  });
});

describe("Project header beside the docked dock", () => {
  const project = {
    id: "p1",
    name: "Radnetz",
    updated_at: "2026-10-01T10:00:00Z",
    tags: [],
  } as unknown as ComponentProps<typeof Header>["project"];
  const projectHeader = () => render(<Header mapHeader project={project} showHambugerMenu={false} />);

  it("shows Share with its label while the dock is closed", () => {
    viewport(false);
    projectHeader();
    const share = screen.getByRole("button", { name: "common:share" });
    expect(share.className).toContain("MuiButton-root");
    expect(share.textContent).toBe("common:share");
  });

  it("shows Share and the trial notice as icons while the dock is docked open", () => {
    viewport(false);
    authz.isOrgAdmin = true;
    // Ten days ahead, so the notice counts days whatever day the test runs.
    org.organization = {
      on_trial: true,
      plan_renewal_date: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    };
    setDockState({ open: true });
    projectHeader();
    const share = screen.getByRole("button", { name: "common:share" });
    expect(share.className).toContain("MuiIconButton-root");
    expect(share.textContent).toBe("");
    const trial = screen.getByRole("button", { name: "trial_days_left" });
    expect(trial.className).toContain("MuiIconButton-root");
    expect(trial.textContent).toBe("");
  });

  it("keeps the labelled Share while the dock is open full screen", () => {
    viewport(false);
    setDockState({ open: true, expanded: true });
    projectHeader();
    expect(screen.getByRole("button", { name: "common:share" }).className).toContain("MuiButton-root");
  });
});
