import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import UserInfoMenu from "@/components/UserInfoMenu";

const { countsMock, state, push, changeLanguage, updateSystemSettings } = vi.hoisted(() => ({
  countsMock: vi.fn(),
  state: {
    roles: [] as string[],
    billing: false as boolean | undefined,
    language: "de",
  },
  push: vi.fn(),
  changeLanguage: vi.fn(),
  updateSystemSettings: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: state.language, changeLanguage } }),
}));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/api/users", () => ({
  useOrganization: () => ({ organization: { name: "Org" } }),
  useUserProfile: () => ({
    userProfile: { firstname: "A", lastname: "B", email: "a@b.de", roles: state.roles },
  }),
  useFeatures: () => ({ features: state.billing === undefined ? undefined : { billing: state.billing } }),
}));
vi.mock("@/lib/api/system/client", () => ({ updateSystemSettings }));
vi.mock("react-toastify", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/support/SupportMenu", () => ({
  SupportMenuEntries: () => null,
  supportCountLabel: (_t: unknown, c: { needsReply: number; unread: number }) =>
    c.needsReply ? `to_answer:${c.needsReply}` : c.unread ? `unread:${c.unread}` : undefined,
  useSupportCounts: countsMock,
}));

const dot = (container: HTMLElement) => container.querySelector(".MuiBadge-dot");

describe("UserInfoMenu support dot", () => {
  beforeEach(() => countsMock.mockReset());

  it("is warning-coloured when tickets wait for an answer", () => {
    countsMock.mockReturnValue({ needsReply: 1, unread: 2 });
    const { container } = render(<UserInfoMenu withSupport />);
    expect(dot(container)?.classList.contains("MuiBadge-invisible")).toBe(false);
    expect(dot(container)?.classList.contains("MuiBadge-colorWarning")).toBe(true);
  });

  it("is primary-coloured when tickets are only unread", () => {
    countsMock.mockReturnValue({ needsReply: 0, unread: 2 });
    const { container } = render(<UserInfoMenu withSupport />);
    expect(dot(container)?.classList.contains("MuiBadge-invisible")).toBe(false);
    expect(dot(container)?.classList.contains("MuiBadge-colorPrimary")).toBe(true);
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("account_menu: unread:2");
  });

  it("is named as the account menu, says whether it is open, and adds the count", () => {
    countsMock.mockReturnValue(null);
    const { container } = render(<UserInfoMenu />);
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("account_menu");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button as HTMLButtonElement);
    expect(button?.getAttribute("aria-expanded")).toBe("true");
  });

  it("is hidden when nothing is waiting or support is off", () => {
    countsMock.mockReturnValue({ needsReply: 0, unread: 0 });
    const { container, rerender } = render(<UserInfoMenu withSupport />);
    expect(dot(container)?.classList.contains("MuiBadge-invisible")).toBe(true);
    countsMock.mockReturnValue(null);
    rerender(<UserInfoMenu withSupport />);
    expect(dot(container)?.classList.contains("MuiBadge-invisible")).toBe(true);
  });
});

describe("UserInfoMenu entries", () => {
  const fetchMock = vi.fn();
  const openMenu = () => {
    render(<UserInfoMenu />);
    fireEvent.click(screen.getByRole("button", { name: "account_menu" }));
  };

  beforeEach(() => {
    countsMock.mockReset().mockReturnValue(null);
    Object.assign(state, { roles: [], billing: false, language: "de" });
    push.mockReset();
    changeLanguage.mockReset();
    updateSystemSettings.mockReset().mockImplementation(async (body) => body);
    fetchMock.mockReset().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("says who is signed in, and in which organization and role", () => {
    state.roles = ["organization-editor"];
    openMenu();
    expect(screen.getByText("A B")).toBeInTheDocument();
    expect(screen.getByText("a@b.de")).toBeInTheDocument();
    expect(screen.getByText("Org · organization-editor")).toBeInTheDocument();
  });

  it("opens the profile and closes", async () => {
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "settings_nav_profile" }));
    expect(push).toHaveBeenCalledWith("/settings/profile");
    await expect(screen.getByRole("button", { name: "account_menu" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("lists usage for an owner or admin of an organization with billing", () => {
    Object.assign(state, { roles: ["organization-admin"], billing: true });
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "settings_nav_usage" }));
    expect(push).toHaveBeenCalledWith("/settings/usage");
  });

  it.each([
    ["an editor", ["organization-editor"], true],
    ["a viewer", ["organization-viewer"], true],
    ["an admin without billing", ["organization-admin"], false],
    ["an admin while billing is unknown", ["organization-admin"], undefined],
  ])("lists no usage for %s", (_who, roles, billing) => {
    Object.assign(state, { roles, billing });
    openMenu();
    expect(screen.getByRole("button", { name: "settings_nav_profile" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /settings_nav_usage/ })).toBeNull();
  });

  it("switches the appearance in place", async () => {
    openMenu();
    const group = screen.getByRole("group", { name: "settings_prefs_appearance_title" });
    expect(group).toBeInTheDocument();
    await expect(screen.getByRole("button", { name: "settings_prefs_light" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    fireEvent.click(screen.getByRole("button", { name: "settings_prefs_dark" }));
    expect(updateSystemSettings).toHaveBeenCalledWith({
      preferred_language: "de",
      client_theme: "dark",
      unit: "metric",
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "settings_prefs_dark" })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    );
    await expect(screen.getByRole("button", { name: "account_menu" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("switches the language in place", async () => {
    openMenu();
    expect(screen.getByRole("group", { name: "settings_prefs_language_title" })).toBeInTheDocument();
    await expect(screen.getByRole("button", { name: "Deutsch" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(updateSystemSettings).toHaveBeenCalledWith({
      preferred_language: "en",
      client_theme: "light",
      unit: "metric",
    });
    await waitFor(() => expect(changeLanguage).toHaveBeenCalledWith("en"));
  });

  it("does nothing when the current choice is picked again", () => {
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Deutsch" }));
    fireEvent.click(screen.getByRole("button", { name: "settings_prefs_light" }));
    expect(updateSystemSettings).not.toHaveBeenCalled();
  });
});
