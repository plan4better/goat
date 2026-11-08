import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import type { CreditBalance } from "@/lib/api/usage";

import UsagePage from "@/app/(dashboard)/settings/usage/page";

const state = vi.hoisted(() => ({
  features: { billing: true } as Record<string, unknown> | undefined,
  featuresError: undefined as unknown,
  admin: { isOrgAdmin: true, isLoading: false, isUserProfileError: undefined as unknown },
  balance: undefined as CreditBalance | undefined,
  balanceError: undefined as unknown,
  balanceEnabled: [] as boolean[],
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: state.replace }),
  usePathname: () => "/settings/usage",
}));
vi.mock("@/lib/api/users", () => ({
  useFeatures: () => ({ features: state.features, isError: state.featuresError }),
}));
vi.mock("@/hooks/auth/AuthZ", () => ({ useAuthZ: () => state.admin }));
vi.mock("@/lib/api/usage", () => ({
  useCreditBalance: (enabled: boolean) => {
    state.balanceEnabled.push(enabled);
    return {
      balance: enabled ? state.balance : undefined,
      isLoading: enabled && !state.balance && !state.balanceError,
      isError: state.balanceError,
    };
  },
}));
vi.mock("@/components/support/SupportMenu", () => ({ useReportProblemHref: () => "/support/new" }));
vi.mock("@/components/settings/usage/CreditsDetail", () => ({ CreditsDetail: () => <p>credits detail</p> }));
vi.mock("@/components/settings/usage/AiCreditsDetail", () => ({
  AiCreditsDetail: () => <p>ai credits detail</p>,
}));
vi.mock("@/components/settings/usage/StorageDetail", () => ({ StorageDetail: () => <p>storage detail</p> }));
vi.mock("@/components/settings/usage/ProjectsDetail", () => ({
  ProjectsDetail: () => <p>projects detail</p>,
}));
vi.mock("@/components/settings/usage/EditorsDetail", () => ({
  EditorsDetail: ({ onOpenUsage }: { onOpenUsage: (quota: "credits" | "ai", id: string) => void }) => (
    <>
      <button onClick={() => onOpenUsage("credits", "u2")}>open credits of Tim</button>
      <button onClick={() => onOpenUsage("ai", "u3")}>open AI credits of Lea</button>
    </>
  ),
}));

const BALANCE: CreditBalance = {
  rates: [],
  used_credits: 2204,
  total_credits: 10000,
  over_budget: false,
  used_ai_credits: 412,
  total_ai_credits: 2000,
  ai_credits_per_editor: 200,
  ai_credit_tiers: [],
  plan_renewal_date: null,
  on_trial: false,
  credits_reset_at: "2026-11-30T12:00:00",
  period_start: "2026-10-31T12:00:00",
  used_storage: 1000,
  total_storage: 51200,
  used_projects: 10,
  total_projects: 1000,
  used_editors: 3,
  total_editors: 10,
  used_viewers: 2,
  total_viewers: 50,
};

const onUrlUpdate = vi.fn();

const renderPage = (searchParams = "") => {
  const Nuqs = withNuqsTestingAdapter({ searchParams, onUrlUpdate });
  return render(<UsagePage />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <Nuqs>
        <I18nextProvider i18n={commonI18n("en")}>{children}</I18nextProvider>
      </Nuqs>
    ),
  });
};

describe("Usage page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
    state.features = { billing: true };
    state.featuresError = undefined;
    state.admin = { isOrgAdmin: true, isLoading: false, isUserProfileError: undefined };
    state.balance = BALANCE;
    state.balanceError = undefined;
    state.balanceEnabled = [];
    state.replace.mockReset();
    onUrlUpdate.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing while the feature flags load", () => {
    state.features = undefined;
    const { container } = renderPage();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an error when the feature flags fail to load", () => {
    state.features = undefined;
    state.featuresError = new Error("500");
    renderPage();
    expect(screen.getByText("Usage could not be loaded. Please reload the page.")).toBeInTheDocument();
  });

  it("is called Usage and says who sees it and which period it shows", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Usage" })).toBeInTheDocument();
    expect(
      screen.getByText("Credits period 31 Oct to 30 Nov 2026. Only owners and admins see this page.")
    ).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Quotas" })).toBeInTheDocument();
  });

  it("opens the tile's detail before the balance answers, so its breakdowns start at once", () => {
    state.balance = undefined;
    renderPage();
    expect(state.balanceEnabled.at(-1)).toBe(true);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("credits detail");
  });

  it("names its nav group above the title", () => {
    renderPage();
    expect(screen.getByText("Organization")).toBeInTheDocument();
  });

  it("opens on the credits when nothing needs attention, without writing the address", () => {
    renderPage();
    expect(screen.getByRole("tab", { name: /^Credits/ }).getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel", { name: /^Credits/ });
    expect(panel).toHaveTextContent("credits detail");
    expect(onUrlUpdate).not.toHaveBeenCalled();
  });

  it("opens on Credits even when another quota needs attention", () => {
    state.balance = { ...BALANCE, used_storage: 60000 };
    renderPage();
    expect(screen.getByRole("tab", { name: /^Credits/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: /^Credits/ })).toHaveTextContent("credits detail");
    // The Storage tile still says it needs attention.
    const storage = screen.getByRole("tab", { name: /^Storage/ });
    expect(storage.getAttribute("aria-selected")).toBe("false");
    expect(storage).toHaveTextContent("needs attention");
    expect(onUrlUpdate).not.toHaveBeenCalled();
  });

  it("opens the quota named in the address", () => {
    renderPage("?quota=ai");
    expect(screen.getByRole("tab", { name: /^AI credits/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: /^AI credits/ })).toHaveTextContent("ai credits detail");
  });

  it("shows the detail of each tile", async () => {
    renderPage("?quota=storage");
    expect(screen.getByRole("tabpanel", { name: /^Storage/ })).toHaveTextContent("storage detail");
    await userEvent.click(screen.getByRole("tab", { name: /^Projects/ }));
    expect(screen.getByRole("tabpanel", { name: /^Projects/ })).toHaveTextContent("projects detail");
  });

  it("opens Credits narrowed to a member from Editors", async () => {
    renderPage("?quota=editors");
    await userEvent.click(screen.getByRole("button", { name: "open credits of Tim" }));
    const params = onUrlUpdate.mock.calls.at(-1)?.[0].searchParams as URLSearchParams;
    expect(params.get("quota")).toBe("credits");
    expect(params.get("member")).toBe("u2");
    expect(screen.getByRole("tab", { name: /^Credits/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: /^Credits/ })).toHaveTextContent("credits detail");
  });

  it("opens AI credits narrowed to a member from Editors", async () => {
    renderPage("?quota=editors");
    await userEvent.click(screen.getByRole("button", { name: "open AI credits of Lea" }));
    const params = onUrlUpdate.mock.calls.at(-1)?.[0].searchParams as URLSearchParams;
    expect(params.get("quota")).toBe("ai");
    expect(params.get("member")).toBe("u3");
    expect(screen.getByRole("tabpanel", { name: /^AI credits/ })).toHaveTextContent("ai credits detail");
  });

  it("writes the quota to the address on a click", async () => {
    renderPage("?quota=credits&member=u1");
    await userEvent.click(screen.getByRole("tab", { name: /^AI credits/ }));
    let params = onUrlUpdate.mock.calls.at(-1)?.[0].searchParams as URLSearchParams;
    expect(params.get("quota")).toBe("ai");
    // The member narrows both credit details, and nothing else.
    expect(params.get("member")).toBe("u1");
    await userEvent.click(screen.getByRole("tab", { name: /^Projects/ }));
    params = onUrlUpdate.mock.calls.at(-1)?.[0].searchParams as URLSearchParams;
    expect(params.get("quota")).toBe("projects");
    expect(params.has("member")).toBe(false);
    expect(onUrlUpdate.mock.calls.at(-1)?.[0].options.history).toBe("replace");
  });

  it("shows a trial's end and a way to talk about a plan", () => {
    state.balance = { ...BALANCE, on_trial: true, plan_renewal_date: "2026-11-14T12:00:00" };
    renderPage();
    expect(
      screen.getByText("Trial until 14 Nov 2026. Only owners and admins see this page.")
    ).toBeInTheDocument();
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(
      "Trial until 14 Nov 2026. These quotas hold for the whole trial and don't reset."
    );
    expect(screen.getByRole("link", { name: "Talk to us about a plan" }).getAttribute("href")).toBe(
      "/support/new"
    );
  });

  it("says so when the balance cannot be read", () => {
    state.balance = undefined;
    state.balanceError = new Error("500");
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Usage could not be loaded. Please reload the page.");
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
  });

  it("shows an error, not a redirect, when the profile fails to load", () => {
    state.admin = { isOrgAdmin: false, isLoading: false, isUserProfileError: new Error("500") };
    renderPage();
    expect(screen.getByText("Usage could not be loaded. Please reload the page.")).toBeInTheDocument();
    expect(state.replace).not.toHaveBeenCalled();
  });

  it("keeps sending members who are not admins away", () => {
    state.admin = { isOrgAdmin: false, isLoading: false, isUserProfileError: undefined };
    const { container } = renderPage();
    expect(state.replace).toHaveBeenCalledWith("/settings/profile");
    expect(container).toBeEmptyDOMElement();
    // Nor does it ask for the balance on their behalf.
    expect(state.balanceEnabled.every((enabled) => !enabled)).toBe(true);
  });

  it("waits for the user's roles before deciding", () => {
    state.admin = { isOrgAdmin: false, isLoading: true, isUserProfileError: undefined };
    const { container } = renderPage();
    expect(state.replace).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("leaves for the account settings when billing is off", () => {
    state.features = { billing: false };
    renderPage();
    expect(state.replace).toHaveBeenCalledWith("/settings/profile");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });
});
