import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Header from "@/components/header/Header";

const { support, profile, org, features, admin } = vi.hoisted(() => ({
  support: { value: { summary: undefined, enabled: false } as { summary: unknown; enabled: boolean } },
  profile: { value: { id: "u1" } as { id: string } | undefined },
  org: { value: undefined as { on_trial: boolean; plan_renewal_date: string } | undefined },
  features: { value: { billing: false, support: false } },
  admin: { value: false },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }),
  Trans: () => null,
}));
vi.mock("react-map-gl/maplibre", () => ({ useMap: () => ({ map: undefined }) }));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));
vi.mock("@/lib/api/support", () => ({ useSupportSummary: () => support.value }));
vi.mock("@/lib/api/users", () => ({
  useOrganization: () => ({ organization: org.value }),
  useFeatures: () => ({ features: features.value }),
  useUserProfile: () => ({ userProfile: profile.value }),
}));
vi.mock("@/lib/constants", () => ({
  CONTACT_URL: "",
  DOCS_URL: "https://docs.example/docs",
  SUPPORT_MAILTO: "",
  privacyPolicyUrl: () => "",
}));
vi.mock("@/hooks/auth/AuthZ", () => ({ useAuthZ: () => ({ isOrgAdmin: admin.value }) }));
vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => undefined,
}));
vi.mock("@/components/header/Toolbar", () => ({
  TOOLBAR_HEIGHT: 52,
  Toolbar: ({
    LeftToolbarChild,
    RightToolbarChild,
  }: {
    LeftToolbarChild: ReactNode;
    RightToolbarChild: ReactNode;
  }) => (
    <div>
      {LeftToolbarChild}
      {RightToolbarChild}
    </div>
  ),
}));
vi.mock("@/components/support/SupportMenu", () => ({ default: () => <div data-testid="support-menu" /> }));
vi.mock("@/components/UserInfoMenu", () => ({
  default: ({ withSupport }: { withSupport?: boolean }) => (
    <div data-testid="user-menu" data-with-support={String(!!withSupport)} />
  ),
}));
vi.mock("@/components/common/EditableTypography", () => ({ default: () => null }));
vi.mock("@/components/common/PopperMenu", () => ({
  default: ({ menuItems }: { menuItems: { id: string; label: string }[] }) => (
    <ul>
      {menuItems.map((item) => (
        <li key={item.id}>{item.label}</li>
      ))}
    </ul>
  ),
}));
vi.mock("@/components/common/SlidingToggle", () => ({ default: () => null }));
vi.mock("@/components/header/OnboardingTray", () => ({ default: () => null }));
vi.mock("@/components/header/StatusDot", () => ({ default: () => null }));
vi.mock("@/components/header/WhatsNewPopper", () => ({ default: () => null }));
vi.mock("@/components/jobs/JobsPopper", () => ({ default: () => null }));
vi.mock("@/components/modals/ContentDelete", () => ({ default: () => null }));
vi.mock("@/components/modals/Metadata", () => ({ default: () => null }));
vi.mock("@/components/modals/content/ProjectShareDialog", () => ({ default: () => null }));
vi.mock("@/components/templates/SaveTemplateDialog", () => ({ default: () => null }));
vi.mock("@/lib/store/layer/slice", () => ({ setSelectedLayers: vi.fn() }));
vi.mock("@/lib/store/map/slice", () => ({ setMapMode: vi.fn(), setActiveRightPanel: vi.fn() }));
vi.mock("@/components/header/OnboardingTray", () => ({ default: () => null }));

const book = () => screen.queryByRole("button", { name: "common:open_documentation" });

// The documentation link lives in the support popover (desktop) and the user menu (phone).
describe("Header documentation icon", () => {
  beforeEach(() => {
    support.value = { summary: undefined, enabled: false };
    profile.value = { id: "u1" };
  });

  it('has no "report an issue" entry any more: the support popover carries it', () => {
    render(<Header mapHeader />);
    expect(screen.queryByText("common:report_an_issue")).toBeNull();
    expect(screen.getByText("common:home")).toBeTruthy();
  });

  it("is not in the header, whatever the support state", () => {
    const { unmount } = render(<Header />);
    expect(book()).toBeNull();
    unmount();
    support.value = { summary: { needs_reply: 0, unread: 0 }, enabled: true };
    render(<Header />);
    expect(book()).toBeNull();
  });
});

// Read-only viewers can still ask for help: the support entry is not tied to edit rights.
describe("Header support entry for read-only viewers", () => {
  beforeEach(() => {
    support.value = { summary: { needs_reply: 0, unread: 0 }, enabled: true };
    profile.value = { id: "u1" };
  });

  it("shows the support entry in the view-only header of a logged-in user", () => {
    render(<Header viewOnly />);
    expect(screen.getByTestId("support-menu")).toBeTruthy();
    expect(screen.getByTestId("user-menu")).toBeTruthy();
  });

  it("shows it in the normal header as well", () => {
    render(<Header />);
    expect(screen.getByTestId("support-menu")).toBeTruthy();
  });
});

// Trials exist only where billing is on: a self-hosted install never shows the chip,
// even for an organization that still carries a trial from earlier.
describe("Header trial chip", () => {
  beforeEach(() => {
    support.value = { summary: undefined, enabled: false };
    profile.value = { id: "u1" };
    admin.value = true;
    org.value = { on_trial: true, plan_renewal_date: new Date(Date.now() + 10 * 86_400_000).toISOString() };
  });

  it("shows the days left to an admin when billing is on", () => {
    features.value = { billing: true, support: false };
    render(<Header />);
    expect(screen.getByText("trial_days_left")).toBeTruthy();
  });

  it("is not shown without billing", () => {
    features.value = { billing: false, support: false };
    render(<Header />);
    expect(screen.queryByText("trial_days_left")).toBeNull();
  });
});

// The API sends naive UTC datetimes; the chip counts calendar days from "now".
describe("Header trial chip by date", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    support.value = { summary: undefined, enabled: false };
    profile.value = { id: "u1" };
    admin.value = true;
    features.value = { billing: true, support: false };
  });
  afterEach(() => vi.useRealTimers());

  const chip = (renewal: string) => {
    org.value = { on_trial: true, plan_renewal_date: renewal };
    render(<Header />);
  };

  it("shows the days left for a future end date", () => {
    chip("2026-10-25T12:00:00");
    expect(screen.getByText("trial_days_left")).toBeTruthy();
    expect(screen.queryByText("trial_expired")).toBeNull();
  });

  it("says the trial ends today on the last day", () => {
    chip("2026-10-20T18:00:00");
    expect(screen.getByText("trial_ends_today")).toBeTruthy();
  });

  it("says the trial expired once the end date is past", () => {
    chip("2026-10-18T12:00:00");
    expect(screen.getByText("trial_expired")).toBeTruthy();
    expect(screen.queryByText("trial_ends_today")).toBeNull();
  });
});
