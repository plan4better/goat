import { ThemeProvider, createTheme } from "@mui/material";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import breakpoints from "@p4b/ui/theme/breakpoints";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import PageHeader from "@/components/dashboard/common/PageHeader";
import SettingsPage from "@/components/settings/common/SettingsPage";

import SettingsLayout from "@/app/(dashboard)/settings/layout";

const state = vi.hoisted(() => ({
  pathname: "/settings/profile",
  replace: vi.fn(),
  roles: ["organization-owner"] as string[] | undefined,
  billing: true as boolean | undefined,
  whiteLabel: true as boolean | undefined,
  organization: { id: "org-1", name: "Stadt Musterhausen", avatar: "" } as
    | { id: string; name: string; avatar: string }
    | undefined,
  isError: false,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ replace: state.replace, push: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/components/settings/nav/useSettingsNavInput", () => ({
  useSettingsNavInput: () => ({
    input: {
      roles: state.roles,
      features: { billing: state.billing, whiteLabel: state.whiteLabel },
      assistant: true,
    },
    organization: state.organization,
    memberCount: 12,
    needsAttention: true,
    isError: state.isError,
  }),
}));

const renderAt = (pathname: string) => {
  state.pathname = pathname;
  return render(
    <I18nextProvider i18n={commonI18n("en")}>
      <SettingsLayout>
        <p>page body</p>
      </SettingsLayout>
    </I18nextProvider>
  );
};

const nav = () => screen.getByRole("navigation", { name: "Settings" });

describe("SettingsLayout", () => {
  beforeEach(() => {
    state.replace.mockReset();
    state.roles = ["organization-owner"];
    state.billing = true;
    state.whiteLabel = true;
    state.organization = { id: "org-1", name: "Stadt Musterhausen", avatar: "" };
    state.isError = false;
    window.localStorage.clear();
  });

  it("lays every page on the page background under the h1", () => {
    renderAt("/settings/members");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("page body").closest(".MuiPaper-root")).toBeNull();
  });

  it("spans the width it is given, so the nav keeps its place whatever the page holds", async () => {
    state.pathname = "/settings/teams";
    // GOAT's breakpoints: Content's frame is as wide as the theme's `xl`.
    const goat = createTheme({ breakpoints: breakpoints() });
    const { container } = render(
      <ThemeProvider theme={goat}>
        <I18nextProvider i18n={commonI18n("en")}>
          <SettingsLayout>
            <p>page body</p>
          </SettingsLayout>
        </I18nextProvider>
      </ThemeProvider>
    );
    // The dashboard's main is a flex column: a centred item without a width
    // would shrink to its content and move the nav with every page.
    await expect(container.firstElementChild).toHaveStyle({
      width: "100%",
      maxWidth: `${goat.breakpoints.values.xl}px`,
    });
    expect(goat.breakpoints.values.xl).toBe(1432);
  });

  it("scrolls the page as one under a title and a nav that stay", () => {
    state.pathname = "/settings/members";
    render(
      <I18nextProvider i18n={commonI18n("en")}>
        <SettingsLayout>
          <SettingsPage header={<PageHeader level={2} eyebrow="Organization" title="Members" />}>
            <p>page body</p>
          </SettingsPage>
        </SettingsLayout>
      </I18nextProvider>
    );
    const scrollerOf = (element: Element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (getComputedStyle(node).overflowY === "auto") return node;
      }
      return null;
    };
    const body = scrollerOf(screen.getByText("page body"));
    expect(body).not.toBeNull();
    // Nothing above the page's own scroll area scrolls: one scroll area only.
    expect(scrollerOf(body as Element)).toBeNull();
    for (const fixed of [screen.getByRole("heading", { level: 1, name: "Settings" }), nav()]) {
      expect(scrollerOf(fixed)).toBeNull();
    }
    // The page's heading scrolls with its cards (RV1d).
    expect(scrollerOf(screen.getByRole("heading", { level: 2, name: "Members" }))).toBe(body);
  });

  it("gives an owner the organization's pages in the Organization group", async () => {
    renderAt("/settings/profile");
    const organization = within(nav()).getByRole("group", { name: "Organization" });
    for (const name of ["Profile", "Members", "Teams", "Domains", "Analytics", "AI"]) {
      expect(within(organization).getByRole("link", { name }), name).toBeInTheDocument();
    }
    expect(within(organization).getByRole("link", { name: /^Usage/ })).toHaveTextContent("needs attention");
    await expect(within(organization).getByRole("button", { name: "White Label" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    const account = within(nav()).getByRole("group", { name: "Account" });
    await expect(within(account).getByRole("link", { name: "Profile" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(within(account).getByRole("link", { name: "Language and appearance" })).toHaveAttribute(
      "href",
      "/settings/preferences"
    );
  });

  it("gives an editor only the profile and teams of the organization", () => {
    state.roles = ["organization-editor"];
    renderAt("/settings/teams");
    const organization = within(nav()).getByRole("group", { name: "Organization" });
    expect(
      within(organization)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["Profile", "Teams"]);
    expect(within(organization).queryByRole("button", { name: "White Label" })).toBeNull();
  });

  it("draws the nav before the roles are known, with skeletons for the admin rows", () => {
    state.roles = undefined;
    renderAt("/settings/members");
    expect(within(nav()).getByRole("link", { name: "Language and appearance" })).toBeInTheDocument();
    expect(nav().querySelectorAll(".MuiSkeleton-root").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(state.replace).not.toHaveBeenCalled();
  });

  it("sends a role away from a page it may not open, and draws no page", () => {
    state.roles = ["organization-viewer"];
    renderAt("/settings/members");
    expect(state.replace).toHaveBeenCalledWith("/settings/profile");
    expect(screen.queryByText("page body")).toBeNull();
  });

  it("sends an admin away from White Label without the feature", () => {
    state.roles = ["organization-admin"];
    state.whiteLabel = false;
    renderAt("/settings/domains");
    expect(state.replace).toHaveBeenCalledWith("/settings/profile");
  });

  it("keeps White Label closed as the viewer left it, unless a child is current", async () => {
    window.localStorage.setItem("goat.settings.whiteLabelOpen", "0");
    const { unmount } = renderAt("/settings/profile");
    await expect(within(nav()).getByRole("button", { name: "White Label" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    unmount();
    renderAt("/settings/analytics");
    await expect(within(nav()).getByRole("button", { name: "White Label" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("offers the sections as a sheet below md", async () => {
    renderAt("/settings/members");
    await userEvent.click(screen.getByRole("button", { name: "Organization › Members" }));
    const sheet = await screen.findByRole("dialog", { name: "Settings sections" });
    await expect(within(sheet).getByRole("link", { name: "Domains" })).toHaveAttribute(
      "href",
      "/settings/domains"
    );
    expect(within(sheet).queryByRole("button", { name: "White Label" })).toBeNull();
  });

  it("gives the sections button below md a navigation landmark, as the desktop nav has one", () => {
    renderAt("/settings/members");
    const phone = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(phone).getByRole("button", { name: "Organization › Members" })).toBeInTheDocument();
  });

  it("marks White Label as unavailable while a child is current, and only then", async () => {
    const { unmount } = renderAt("/settings/domains");
    await expect(within(nav()).getByRole("button", { name: "White Label" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    unmount();
    renderAt("/settings/profile");
    await expect(within(nav()).getByRole("button", { name: "White Label" })).not.toHaveAttribute(
      "aria-disabled"
    );
  });

  it("closes the sheet from its close button", async () => {
    renderAt("/settings/members");
    await userEvent.click(screen.getByRole("button", { name: "Organization › Members" }));
    const sheet = await screen.findByRole("dialog", { name: "Settings sections" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("folds White Label on a click and remembers it", async () => {
    renderAt("/settings/profile");
    const button = within(nav()).getByRole("button", { name: "White Label" });
    await userEvent.click(button);
    await expect(button).toHaveAttribute("aria-expanded", "false");
    expect(window.localStorage.getItem("goat.settings.whiteLabelOpen")).toBe("0");
    await userEvent.click(button);
    await expect(button).toHaveAttribute("aria-expanded", "true");
    expect(window.localStorage.getItem("goat.settings.whiteLabelOpen")).toBe("1");
  });

  it("ignores a White Label click while a child is current, so other pages keep it open", async () => {
    const { unmount } = renderAt("/settings/domains");
    const button = within(nav()).getByRole("button", { name: "White Label" });
    await userEvent.click(button);
    await expect(button).toHaveAttribute("aria-expanded", "true");
    expect(window.localStorage.getItem("goat.settings.whiteLabelOpen")).toBeNull();
    unmount();
    renderAt("/settings/profile");
    await expect(within(nav()).getByRole("button", { name: "White Label" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("names Usage and its attention hint as one phrase", () => {
    renderAt("/settings/profile");
    expect(within(nav()).getByRole("link", { name: "Usage needs attention" })).toBeInTheDocument();
  });

  it("names the current page on the phone button while the roles load", () => {
    state.roles = undefined;
    const { unmount } = renderAt("/settings/members");
    expect(screen.getByRole("button", { name: "Organization › Members" })).toBeInTheDocument();
    unmount();
    renderAt("/settings/domains");
    expect(screen.getByRole("button", { name: "White Label › Domains" })).toBeInTheDocument();
  });

  it("drops the skeletons when a request the nav waits on failed, names the group, and redirects nowhere", () => {
    state.roles = undefined;
    state.organization = undefined;
    state.isError = true;
    renderAt("/settings/members");
    expect(nav().querySelectorAll(".MuiSkeleton-root")).toHaveLength(0);
    const organization = within(nav()).getByRole("group", { name: "Organization" });
    expect(within(organization).getByText("Organization")).toBeInTheDocument();
    expect(
      within(organization)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["Profile", "Teams"]);
    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(state.replace).not.toHaveBeenCalled();
  });
});
