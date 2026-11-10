import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import OrganizationOnBoarding from "@/app/onboarding/organization/create/page";

const state = vi.hoisted(() => ({
  billing: false,
  privacyUrl: undefined as string | undefined,
  push: vi.fn(),
  replace: vi.fn(),
  update: vi.fn(),
  signOut: vi.fn(),
  createOrganization: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: { user: { email: "anna@example.org" } },
    update: state.update,
  }),
  signOut: state.signOut,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push, replace: state.replace }) }));
vi.mock("@/lib/api/organizations", () => ({ createOrganization: state.createOrganization }));
vi.mock("@/lib/api/users", () => ({
  useFeatures: () => ({ features: { billing: state.billing, support: false } }),
  useOrganizationCreation: () => ({ organizationCreation: { allowed: true } }),
}));
vi.mock("@/lib/constants", async (original) => ({
  ...(await original<typeof import("@/lib/constants")>()),
  privacyPolicyUrl: () => state.privacyUrl,
}));

const renderPage = () =>
  render(
    <I18nextProvider i18n={commonI18n("de")}>
      <OrganizationOnBoarding />
    </I18nextProvider>
  );

const fillIn = async () => {
  await userEvent.type(screen.getByRole("textbox", { name: /^Name der Organisation/ }), "Stadt Musterhausen");
  await userEvent.click(screen.getByRole("combobox", { name: /^Organisationstyp/ }));
  await userEvent.click(screen.getByRole("option", { name: "Öffentliche Verwaltung" }));
};

describe("Create organization", () => {
  beforeEach(() => {
    state.billing = false;
    state.privacyUrl = undefined;
    for (const mock of [state.push, state.replace, state.update, state.signOut]) mock.mockReset();
    state.createOrganization.mockReset().mockResolvedValue({});
  });

  it("titles the page and puts each field's label above it", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Organisation erstellen" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^Name der Organisation/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^Organisationstyp/ })).toBeInTheDocument();
    await expect(screen.getByRole("button", { name: "Organisation erstellen" })).toBeDisabled();
  });

  it("creates the organization and opens the app", async () => {
    renderPage();
    await fillIn();
    await userEvent.click(screen.getByRole("button", { name: "Organisation erstellen" }));
    expect(state.createOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Stadt Musterhausen", type: "government", newsletter_subscribe: false })
    );
    await waitFor(() => expect(state.push).toHaveBeenCalledWith("/"));
    expect(state.update).toHaveBeenCalled();
  });

  it("stays on the page and says so when creating fails", async () => {
    state.createOrganization.mockRejectedValue(new Error("500"));
    renderPage();
    await fillIn();
    await userEvent.click(screen.getByRole("button", { name: "Organisation erstellen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Etwas ist schief gelaufen");
    expect(state.push).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("names the account that is signed in, and signs it out", async () => {
    renderPage();
    expect(screen.getByText(/Angemeldet als anna@example\.org/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(state.signOut).toHaveBeenCalledWith({ callbackUrl: "/" });
  });

  it("mentions the trial only where billing is on", () => {
    const { unmount } = renderPage();
    expect(screen.queryByText(/Testzeitraum/)).toBeNull();
    unmount();
    state.billing = true;
    renderPage();
    expect(screen.getByText(/Testzeitraum/)).toBeInTheDocument();
  });

  it("links the privacy policy where the website is configured", async () => {
    state.privacyUrl = "https://example.org/de/datenschutz";
    renderPage();
    const terms = screen.getByText(/stimmen Sie/);
    await expect(within(terms).getByRole("link", { name: "Datenschutzrichtlinien" })).toHaveAttribute(
      "href",
      "https://example.org/de/datenschutz"
    );
  });

  it("names the privacy policy without a link where no website is configured", () => {
    renderPage();
    expect(screen.getByText(/Datenschutzrichtlinien/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
