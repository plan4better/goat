import { alpha } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import DomainsPage from "@/app/(dashboard)/settings/domains/page";

const api = vi.hoisted(() => ({
  domains: [] as Record<string, unknown>[] | undefined,
  config: { cname_target: "custom.goat.example", apex_ipv4: "203.0.113.7" } as
    | Record<string, unknown>
    | undefined,
  mutate: vi.fn(),
  recheck: vi.fn(),
  unassign: vi.fn(),
  assign: vi.fn(),
  remove: vi.fn(),
  undo: undefined as undefined | (() => Promise<unknown>),
  configError: undefined as unknown,
  configMutate: vi.fn(),
}));

vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/settings/useOrganizationId", () => ({ useOrganizationId: () => "org-1" }));
vi.mock("@/lib/api/customDomainConfig", () => ({
  useCustomDomainConfig: () => api.config,
  useCustomDomainConfigRead: () => ({
    config: api.config,
    isError: api.configError,
    mutate: api.configMutate,
  }),
}));
vi.mock("@/lib/toasts", () => ({
  undoToast: (_message: string, onUndo: () => Promise<unknown>) => {
    api.undo = onUndo;
  },
}));
vi.mock("@/lib/api/customDomains", () => ({
  useOrganizationDomains: () => ({ domains: api.domains, isError: undefined, mutate: api.mutate }),
  recheckCustomDomain: api.recheck,
  unassignDomainFromProject: api.unassign,
  assignDomainToProject: api.assign,
  deleteCustomDomain: api.remove,
  createCustomDomain: vi.fn(),
}));

const domain = (over: Record<string, unknown>) => ({
  id: "d1",
  organization_id: "org-1",
  base_domain: "karten.stadt.example",
  kind: "single",
  dns_status: "verified",
  dns_status_message: null,
  dns_last_checked_at: null,
  cert_status: "active",
  cert_status_message: null,
  created_at: "2026-10-01T10:00:00Z",
  assigned_project_id: "p1",
  assigned_project_name: "Radverkehr",
  ...over,
});

const theme = createAppTheme({ mode: "light", locale: "en" });
const renderPage = () =>
  render(
    <ThemeProvider theme={theme}>
      <I18nextProvider i18n={commonI18n("en")}>
        <DomainsPage />
      </I18nextProvider>
    </ThemeProvider>
  );

const stubClipboard = (writeText: (value: string) => Promise<void>) =>
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

describe("Domains page", () => {
  beforeEach(() => {
    api.domains = [domain({})];
    api.config = { cname_target: "custom.goat.example", apex_ipv4: "203.0.113.7" };
    for (const fn of [api.mutate, api.recheck, api.unassign, api.assign, api.remove])
      fn.mockReset().mockResolvedValue(undefined);
    api.undo = undefined;
    api.configError = undefined;
    api.configMutate.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("shows an active domain as a link with its project and how to point a domain", async () => {
    renderPage();
    const card = screen.getByRole("article", { name: "karten.stadt.example" });
    await expect(within(card).getByRole("link", { name: "karten.stadt.example" })).toHaveAttribute(
      "href",
      "https://karten.stadt.example"
    );
    expect(card).toHaveTextContent("Active");
    expect(card).toHaveTextContent("Radverkehr");
    expect(screen.getByText("CNAME to custom.goat.example")).toBeInTheDocument();
    expect(screen.getByText("A to 203.0.113.7")).toBeInTheDocument();
    expect(screen.getByText("1 domain")).toBeInTheDocument();
  });

  it("opens the details of a waiting domain, with the missing record and what was found", () => {
    api.domains = [
      domain({
        dns_status: "pending",
        cert_status: "pending",
        dns_status_message: "No CNAME found",
        assigned_project_id: null,
        assigned_project_name: null,
      }),
    ];
    renderPage();
    const card = screen.getByRole("article", { name: "karten.stadt.example" });
    expect(card).toHaveTextContent("Waiting for DNS");
    expect(card).toHaveTextContent("This DNS record is still missing");
    expect(card).toHaveTextContent("No CNAME found");
    expect(within(card).getByText("Not assigned")).toHaveStyle({ color: theme.palette.text.secondary });
    expect(within(card).getByRole("table")).toHaveTextContent("CNAME");
    expect(within(card).getByText("What we found").parentElement).toHaveStyle({
      backgroundColor: alpha(theme.palette.warning.main, 0.1),
    });
    expect(within(card).getByRole("button", { name: "Check again" })).toBeInTheDocument();
    // Core never records when it checked: no line about it then.
    expect(card).not.toHaveTextContent("Not checked yet.");
    expect(card).not.toHaveTextContent("Last checked");
  });

  it("says when a domain was last checked, once core says so", () => {
    api.domains = [
      domain({
        dns_status: "pending",
        cert_status: "pending",
        dns_last_checked_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    ];
    renderPage();
    expect(screen.getByRole("article")).toHaveTextContent("Last checked 5 minutes ago.");
  });

  it("lists an active domain's details as terms and definitions", async () => {
    renderPage();
    const card = screen.getByRole("article", { name: "karten.stadt.example" });
    await userEvent.click(within(card).getByRole("button", { name: "Show details" }));
    expect(
      within(card)
        .getAllByRole("term")
        .map((term) => term.textContent)
    ).toEqual(["DNS", "Certificate", "Project"]);
    expect(
      within(card)
        .getAllByRole("definition")
        .map((definition) => definition.textContent)
    ).toEqual(["CNAME karten points to custom.goat.example", "valid, renews itself", "Radverkehr"]);
  });

  it("shows a domain whose certificate is being issued without a check", async () => {
    api.domains = [
      domain({ cert_status: "issuing", assigned_project_id: null, assigned_project_name: null }),
    ];
    renderPage();
    const card = screen.getByRole("article", { name: "karten.stadt.example" });
    expect(card).toHaveTextContent("Certificate being issued");
    await userEvent.click(within(card).getByRole("button", { name: "Show details" }));
    expect(card).toHaveTextContent(
      "DNS confirmed. The SSL certificate is created on the first visit to the address, usually in under 2 minutes."
    );
    expect(within(card).queryByRole("button", { name: /^(Check again|Try again)$/ })).toBeNull();
    await userEvent.click(
      within(card).getByRole("button", { name: "More actions for karten.stadt.example" })
    );
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Delete domain"]);
  });

  it("shows a domain whose DNS check failed with its record, what was found in error ink and a retry", () => {
    api.domains = [
      domain({
        dns_status: "failed",
        cert_status: "pending",
        dns_status_message: "CNAME points to elsewhere.example",
        assigned_project_id: null,
        assigned_project_name: null,
      }),
    ];
    renderPage();
    const card = screen.getByRole("article", { name: "karten.stadt.example" });
    expect(card).toHaveTextContent("Failed");
    expect(within(card).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(card).toHaveTextContent("This DNS record is still missing");
    expect(within(card).getByRole("table")).toHaveTextContent("custom.goat.example");
    const found = within(card).getByText("What we found").parentElement;
    expect(found).toHaveTextContent("CNAME points to elsewhere.example");
    expect(found).toHaveStyle({ backgroundColor: alpha(theme.palette.error.main, 0.1) });
  });

  it("shows a domain whose certificate failed with what was found, without asking for a record", () => {
    api.domains = [
      domain({
        cert_status: "failed",
        cert_status_message: "The certificate authority refused the order",
        assigned_project_id: null,
        assigned_project_name: null,
      }),
    ];
    renderPage();
    const card = screen.getByRole("article", { name: "karten.stadt.example" });
    expect(card).toHaveTextContent("Failed");
    expect(within(card).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(within(card).queryByRole("table")).toBeNull();
    expect(card).not.toHaveTextContent("This DNS record is still missing");
    expect(within(card).getByText("What we found").parentElement).toHaveTextContent(
      "The certificate authority refused the order"
    );
  });

  it("says what a recheck found", async () => {
    api.domains = [domain({ dns_status: "pending", cert_status: "pending" })];
    api.recheck.mockResolvedValue(domain({ dns_status: "verified", cert_status: "issuing" }));
    renderPage();
    await userEvent.click(within(screen.getByRole("article")).getByRole("button", { name: "Check again" }));
    expect(api.recheck).toHaveBeenCalledWith("org-1", "d1");
    expect(toast.success).toHaveBeenCalledWith("DNS for karten.stadt.example found.");
  });

  it("unassigns a domain and puts the assignment back on undo", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More actions for karten.stadt.example" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove assignment" }));
    expect(api.unassign).toHaveBeenCalledWith("p1");
    expect(api.undo).toBeDefined();
    await api.undo?.();
    expect(api.assign).toHaveBeenCalledWith("p1", "d1");
  });

  it("says so when custom domains are not set up, and still lets a domain be deleted", async () => {
    api.config = { cname_target: "", apex_ipv4: null };
    renderPage();
    expect(screen.getByText(/Custom domains are not set up on this instance\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add domain" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "More actions for karten.stadt.example" }));
    expect(screen.getByRole("menuitem", { name: "Delete domain" })).toBeInTheDocument();
  });

  it("does not offer a check while custom domains are not set up (core refuses it)", async () => {
    api.config = { cname_target: "", apex_ipv4: null };
    api.domains = [domain({ dns_status: "pending", cert_status: "pending" })];
    renderPage();
    const card = screen.getByRole("article", { name: "karten.stadt.example" });
    await expect(within(card).getByRole("button", { name: "Check again" })).toBeDisabled();
    await userEvent.click(
      within(card).getByRole("button", { name: "More actions for karten.stadt.example" })
    );
    await expect(screen.getByRole("menuitem", { name: /^Check again/ })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(api.recheck).not.toHaveBeenCalled();
  });

  it("offers neither adding nor a check until core's config says custom domains are on", async () => {
    api.config = undefined;
    api.domains = [
      domain({}),
      domain({
        id: "d2",
        base_domain: "plan.stadt.example",
        dns_status: "pending",
        cert_status: "pending",
        assigned_project_id: null,
        assigned_project_name: null,
      }),
    ];
    renderPage();
    await expect(screen.getByRole("button", { name: "Add domain" })).toBeDisabled();
    const waiting = screen.getByRole("article", { name: "plan.stadt.example" });
    await expect(within(waiting).getByRole("button", { name: "Check again" })).toBeDisabled();
    // The active domain's target comes from the config: not an empty "points to".
    const active = screen.getByRole("article", { name: "karten.stadt.example" });
    expect(active).not.toHaveTextContent("points to");
  });

  it("offers no first domain either until the config is known", async () => {
    api.config = undefined;
    api.domains = [];
    renderPage();
    await expect(screen.getByRole("button", { name: "Add first domain" })).toBeDisabled();
  });

  it("says so in the help card when the config could not be read, with a retry", async () => {
    api.config = undefined;
    api.configError = new Error("502");
    renderPage();
    const help = screen.getByRole("region", { name: "How a domain points to GOAT" });
    expect(help).toHaveTextContent("That could not be loaded.");
    await userEvent.click(within(help).getByRole("button", { name: "Try again" }));
    expect(api.configMutate).toHaveBeenCalled();
  });

  it("invites the first domain when there is none", async () => {
    api.domains = [];
    renderPage();
    expect(screen.getByText("No own domain yet")).toBeInTheDocument();
    await expect(screen.getByRole("button", { name: "Add first domain" })).toBeEnabled();
  });

  it("copies a DNS value and says so, or says that it could not", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Copy custom.goat.example" }));
    expect(writeText).toHaveBeenCalledWith("custom.goat.example");
    expect(toast.success).toHaveBeenCalledWith("Copied to the clipboard.");

    writeText.mockRejectedValue(new Error("denied"));
    await userEvent.click(screen.getByRole("button", { name: "Copy 203.0.113.7" }));
    expect(toast.error).toHaveBeenCalledWith(
      "That could not be copied. Select the value and copy it yourself."
    );
  });

  it("opens the add dialog on first click", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Add domain" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Add domain");
    expect(within(dialog).getByLabelText(/^Domain name/)).toBeInTheDocument();
  });

  it("deletes a domain through its dialog", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More actions for karten.stadt.example" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete domain" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("The domain is assigned to Radverkehr.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete domain" }));
    expect(api.remove).toHaveBeenCalledWith("org-1", "d1");
    expect(toast.success).toHaveBeenCalledWith("karten.stadt.example deleted.");
  });
});
