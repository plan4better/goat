import { act, fireEvent, render, screen } from "@testing-library/react";
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
vi.mock("@/components/assistant/dockLoader", () => ({ prefetchAssistant: vi.fn() }));
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

/** A window this many px wide, as `useMediaQuery` reads its min- and max-width queries. */
function viewport(width: number) {
  window.matchMedia = vi.fn((query: string) => ({
    matches:
      [...query.matchAll(/max-width:\s*([\d.]+)px/g)].every((m) => width <= Number(m[1])) &&
      [...query.matchAll(/min-width:\s*([\d.]+)px/g)].every((m) => width >= Number(m[1])),
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

/** Ask AI as the icon alone (the 32px circle), named by its label. */
function expectIconOnly(button: HTMLElement) {
  expect(button.textContent).toBe("");
  expect(button.getAttribute("aria-label")).toBe("assistant_ask_ai");
  expect(getComputedStyle(button).width).toBe("32px");
}

/** Ask AI with its label shown. */
function expectLabelled(button: HTMLElement) {
  expect(button.textContent).toBe("assistant_ask_ai");
  expect(button.getAttribute("aria-label")).toBeNull();
}

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
    viewport(800);
    render(<Header title="GOAT" />);
    expectIconOnly(screen.getByRole("button", { name: "assistant_ask_ai" }));
  });

  it("shows the labelled button in the workspace header from md up", () => {
    viewport(1024);
    render(<Header title="GOAT" />);
    expectLabelled(screen.getByRole("button", { name: "assistant_ask_ai" }));
  });

  it("names Beta in the tooltip of both buttons, keeping the visible name", async () => {
    for (const width of [800, 1600]) {
      viewport(width);
      const { unmount } = render(<Header title="GOAT" />);
      const button = screen.getByRole("button", { name: "assistant_ask_ai" });
      fireEvent.mouseOver(button);
      expect((await screen.findByRole("tooltip")).textContent).toBe("assistant_ask_ai_tooltip");
      unmount();
    }
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
  const askAi = () => screen.getByRole("button", { name: "assistant_ask_ai" });

  it("labels Ask AI in a wide window while the dock is closed, as on Home", () => {
    viewport(1600);
    projectHeader();
    expectLabelled(askAi());
  });

  it("shows Ask AI as an icon below xl, and beside the docked dock", () => {
    viewport(1400);
    const { unmount } = projectHeader();
    expectIconOnly(askAi());
    unmount();
    viewport(1600);
    setDockState({ open: true });
    projectHeader();
    expectIconOnly(askAi());
  });

  it("keeps keyboard focus on Ask AI as it turns into the icon and back when the dock opens and closes", () => {
    viewport(1600);
    projectHeader();
    const button = askAi();
    act(() => button.focus());
    act(() => setDockState({ open: true }));
    expectIconOnly(askAi());
    expect(askAi()).toBe(button);
    expect(document.activeElement).toBe(button);
    act(() => setDockState({ open: false }));
    expectLabelled(askAi());
    expect(askAi()).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("shows the last save beside the title while the dock is closed", () => {
    viewport(1600);
    projectHeader();
    expect(screen.getByText(/^common:last_saved: /)).toBeTruthy();
  });

  it("moves the last save into the title's tooltip beside the docked dock", async () => {
    viewport(1024);
    setDockState({ open: true });
    projectHeader();
    const title = screen.getByDisplayValue("Radnetz");
    // Not beside the title any more: only the title's hidden description holds it.
    expect(screen.queryAllByText(/^common:last_saved: /).map((element) => element.id)).toEqual([
      title.getAttribute("aria-describedby"),
    ]);
    fireEvent.mouseOver(title);
    expect((await screen.findByRole("tooltip")).textContent).toMatch(/^common:last_saved: /);
  });

  it("describes the title with the last save for keyboard and screen reader users beside the docked dock", () => {
    viewport(1024);
    setDockState({ open: true });
    projectHeader();
    // The focusable title (an input) carries it, not the wrapper the tooltip sits on.
    const title = screen.getByDisplayValue("Radnetz");
    const describedBy = title.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toMatch(/^common:last_saved: /);
  });

  it("does not describe the title while the last save shows beside it", () => {
    viewport(1600);
    projectHeader();
    expect(screen.getByDisplayValue("Radnetz").getAttribute("aria-describedby")).toBeNull();
  });

  it("lets the title shrink to an ellipsis rather than keep a width the column cuts off", () => {
    for (const open of [false, true]) {
      viewport(1600);
      setDockState({ open });
      const { unmount } = projectHeader();
      const wrapper = screen.getByDisplayValue("Radnetz").closest(".MuiInputBase-root")
        ?.parentElement as HTMLElement;
      expect(getComputedStyle(wrapper).minWidth, String(open)).toBe("0px");
      unmount();
    }
    // The last save, while it shows, gives way before the title does.
    setDockState({ open: false });
    projectHeader();
    const lastSaved = screen.getByText(/^common:last_saved: /);
    expect(Number(getComputedStyle(lastSaved).flexShrink)).toBeGreaterThan(1);
  });

  it("leaves Ask AI out where the header asks for it (the dashboard builder's preview)", () => {
    viewport(1600);
    render(<Header mapHeader project={project} viewOnly askAi={false} />);
    expect(screen.queryByRole("button", { name: "assistant_ask_ai" })).toBeNull();
  });

  it("shows Share with its label while the dock is closed", () => {
    viewport(1600);
    projectHeader();
    const share = screen.getByRole("button", { name: "common:share" });
    expect(share.className).toContain("MuiButton-root");
    expect(share.textContent).toBe("common:share");
  });

  it("shows Share and the trial notice as icons while the dock is docked open", () => {
    viewport(1600);
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
    viewport(1600);
    setDockState({ open: true, expanded: true });
    projectHeader();
    expect(screen.getByRole("button", { name: "common:share" }).className).toContain("MuiButton-root");
  });
});
