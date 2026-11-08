import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import AnalyticsPage from "@/app/(dashboard)/settings/analytics/page";

const api = vi.hoisted(() => ({
  organizationId: "org-1" as string | undefined,
  list: [] as Record<string, unknown>[],
  listLoading: false,
  listError: undefined as unknown,
  dashboards: [] as Record<string, unknown>[],
  dashboardsLoading: false,
  dashboardsError: undefined as unknown,
  mutate: vi.fn(),
  mutateDashboards: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  assign: vi.fn(),
}));

vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/settings/useOrganizationId", () => ({ useOrganizationId: () => api.organizationId }));
// As SWR with a null key: without an organization id nothing is read.
vi.mock("@/lib/api/organizationAnalytics", () => ({
  useOrganizationAnalytics: (id: string | undefined) => ({
    analyticsList: id ? api.list : [],
    isLoading: id ? api.listLoading : false,
    isError: id ? api.listError : undefined,
    mutate: api.mutate,
  }),
  useOrganizationAnalyticsDashboards: (id: string | undefined) => ({
    dashboards: id ? api.dashboards : [],
    isLoading: id ? api.dashboardsLoading : false,
    isError: id ? api.dashboardsError : undefined,
    mutate: api.mutateDashboards,
  }),
  createOrganizationAnalytics: api.create,
  updateOrganizationAnalytics: api.update,
  deleteOrganizationAnalytics: api.remove,
  setAnalyticsDashboards: api.assign,
}));

const INSTANCE = (id: string, name: string, usage = 0) => ({
  id,
  organization_id: "org-1",
  name,
  provider: "matomo",
  config: { url: "https://matomo.example.org/", site_id: "5" },
  usage_count: usage,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
});
const DASHBOARD = (id: string, name: string, analytics_id: string | null) => ({
  project_id: id,
  name,
  analytics_id,
});

const HTTPS = "Use an address that starts with https://.";
const DIGITS = "Digits only, for example 5.";

const i18n = commonI18n("en");
const page = () => (
  <I18nextProvider i18n={i18n}>
    <AnalyticsPage />
  </I18nextProvider>
);
const renderPage = () => render(page());

/** A promise the test settles, to look at a dialog while it saves. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const openAssign = async (instance: string) => {
  await userEvent.click(
    within(screen.getByRole("article", { name: instance })).getByRole("button", { name: "Assign dashboards" })
  );
  return screen.findByRole("dialog");
};

const openMenuItem = async (instance: string, item: string) => {
  await userEvent.click(screen.getByRole("button", { name: `More actions for ${instance}` }));
  await userEvent.click(screen.getByRole("menuitem", { name: item }));
  return screen.findByRole("dialog");
};

describe("Analytics page", () => {
  beforeEach(() => {
    api.organizationId = "org-1";
    api.list = [INSTANCE("a1", "Matomo Dashboards", 5), INSTANCE("a2", "Matomo Intern")];
    api.listLoading = false;
    api.listError = undefined;
    api.dashboards = [
      DASHBOARD("p1", "Radverkehr", "a1"),
      DASHBOARD("p2", "Lärm", "a1"),
      DASHBOARD("p3", "Bäume", "a1"),
      DASHBOARD("p4", "Parken", "a1"),
      DASHBOARD("p5", "Schulen", "a1"),
      DASHBOARD("p6", "Kitas", "a2"),
      DASHBOARD("p7", "Wahlen", null),
    ];
    api.dashboardsLoading = false;
    api.dashboardsError = undefined;
    for (const fn of [api.mutate, api.mutateDashboards, api.create, api.update, api.remove])
      fn.mockReset().mockResolvedValue(undefined);
    api.assign.mockReset().mockResolvedValue([]);
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("shows each instance with what it measures", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Analytics" })).toBeInTheDocument();
    const card = screen.getByRole("article", { name: "Matomo Dashboards" });
    expect(within(card).getByRole("heading", { level: 3, name: "Matomo Dashboards" })).toBeInTheDocument();
    expect(card).toHaveTextContent("https://matomo.example.org/");
    expect(card).toHaveTextContent("Site ID 5");
    expect(card).toHaveTextContent("Measures 5 dashboards:");
    expect(card).toHaveTextContent("Radverkehr");
    expect(card).toHaveTextContent("1 more");
    expect(screen.getByRole("article", { name: "Matomo Intern" })).toHaveTextContent("Measures 1 dashboard:");
    expect(screen.getByRole("note")).toHaveTextContent(/custom dimension 1 as “Project ID”/);
    expect(screen.getByRole("button", { name: "Connect Matomo" })).toBeInTheDocument();
  });

  it("says when an instance measures no dashboard yet", () => {
    api.dashboards = [DASHBOARD("p1", "Radverkehr", "a1")];
    renderPage();
    expect(screen.getByRole("article", { name: "Matomo Intern" })).toHaveTextContent(
      "Measures no dashboard yet."
    );
  });

  it("assigns dashboards, saying which move from another instance", async () => {
    renderPage();
    await userEvent.click(
      within(screen.getByRole("article", { name: "Matomo Intern" })).getByRole("button", {
        name: "Assign dashboards",
      })
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Which published dashboards Matomo Intern measures. A dashboard is always measured by one instance only."
    );
    await expect(within(dialog).getByRole("checkbox", { name: /^Kitas/ })).toBeChecked();
    const radverkehr = within(dialog).getByRole("checkbox", { name: /^Radverkehr/ });
    expect(dialog).toHaveTextContent("currently: Matomo Dashboards");
    await userEvent.click(radverkehr);
    expect(dialog).toHaveTextContent("currently: Matomo Dashboards, will be switched");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(api.assign).toHaveBeenCalledWith("org-1", "a2", ["p6", "p1"]);
    expect(api.mutateDashboards).toHaveBeenCalledWith([], { revalidate: false });
    expect(api.mutate).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Dashboard assignment saved.");
  });

  it("filters the dashboards by name and keeps the ticks of the hidden ones", async () => {
    renderPage();
    await userEvent.click(
      within(screen.getByRole("article", { name: "Matomo Intern" })).getByRole("button", {
        name: "Assign dashboards",
      })
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Filter by name" }), "rad");
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /^Radverkehr/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(api.assign).toHaveBeenCalledWith("org-1", "a2", ["p6", "p1"]);
  });

  it("says so when there is no published dashboard to assign", async () => {
    api.dashboards = [];
    renderPage();
    await userEvent.click(
      within(screen.getByRole("article", { name: "Matomo Intern" })).getByRole("button", {
        name: "Assign dashboards",
      })
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("No published dashboards yet. Publish a project to measure it.");
    await expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("keeps the assignment dialog open when saving fails", async () => {
    api.assign.mockRejectedValue(new Error("500"));
    renderPage();
    await userEvent.click(
      within(screen.getByRole("article", { name: "Matomo Intern" })).getByRole("button", {
        name: "Assign dashboards",
      })
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(toast.error).toHaveBeenCalledWith("The assignment could not be saved.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("validates the Matomo form and saves a new instance", async () => {
    api.list = [];
    renderPage();
    expect(screen.getByText("No Matomo instance yet")).toBeInTheDocument();
    // The header has no second "Connect Matomo" while the empty state offers one.
    await userEvent.click(screen.getByRole("button", { name: "Connect Matomo" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Connect Matomo");
    const save = within(dialog).getByRole("button", { name: "Save" });
    await expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "Matomo Dashboards");
    const url = within(dialog).getByLabelText(/^Matomo URL/);
    // Not on the first keystroke: a half typed address is not a mistake yet.
    await userEvent.type(url, "http://matomo.example.org");
    expect(within(dialog).queryByText(HTTPS)).toBeNull();
    await userEvent.tab();
    expect(within(dialog).getByText(HTTPS)).toBeInTheDocument();
    await userEvent.clear(url);
    await userEvent.type(url, "https://matomo.example.org");
    expect(within(dialog).queryByText(HTTPS)).toBeNull();
    const siteId = within(dialog).getByLabelText(/^Site ID/);
    await userEvent.type(siteId, "5a");
    await userEvent.tab();
    expect(within(dialog).getByText(DIGITS)).toBeInTheDocument();
    await userEvent.type(siteId, "{Backspace}");
    await userEvent.click(save);
    expect(api.create).toHaveBeenCalledWith("org-1", {
      name: "Matomo Dashboards",
      provider: "matomo",
      config: { provider: "matomo", url: "https://matomo.example.org/", site_id: "5" },
    });
    expect(api.mutate).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Matomo saved.");
  });

  it("names the field's problem when Enter is pressed on a form that is not valid", async () => {
    api.list = [];
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Connect Matomo" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^Site ID/), "5a{Enter}");
    expect(within(dialog).getByText(DIGITS)).toBeInTheDocument();
    expect(within(dialog).getAllByText("Required")).toHaveLength(2);
    expect(api.create).not.toHaveBeenCalled();
  });

  it("edits an instance from its saved values", async () => {
    renderPage();
    const dialog = await openMenuItem("Matomo Intern", "Edit");
    expect(dialog).toHaveTextContent("Edit Matomo");
    expect(dialog).toHaveTextContent("Matomo Intern");
    await expect(within(dialog).getByLabelText(/^Name/)).toHaveValue("Matomo Intern");
    await expect(within(dialog).getByLabelText(/^Matomo URL/)).toHaveValue("https://matomo.example.org/");
    const siteId = within(dialog).getByLabelText(/^Site ID/);
    await userEvent.clear(siteId);
    await userEvent.type(siteId, "7");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(api.update).toHaveBeenCalledWith("org-1", "a2", {
      name: "Matomo Intern",
      provider: "matomo",
      config: { provider: "matomo", url: "https://matomo.example.org/", site_id: "7" },
    });
    expect(toast.success).toHaveBeenCalledWith("Matomo saved.");
  });

  it("keeps the Matomo dialog open when saving fails, and saves the same values on the next try", async () => {
    api.update.mockRejectedValueOnce(new Error("422"));
    renderPage();
    const dialog = await openMenuItem("Matomo Intern", "Edit");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(toast.error).toHaveBeenCalledWith("Matomo could not be saved.");
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // The fields were disabled during the first try: their values still count.
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(api.update).toHaveBeenLastCalledWith("org-1", "a2", {
      name: "Matomo Intern",
      provider: "matomo",
      config: { provider: "matomo", url: "https://matomo.example.org/", site_id: "5" },
    });
    expect(toast.success).toHaveBeenCalledWith("Matomo saved.");
  });

  it("says how many dashboards stop being measured when an instance is removed", async () => {
    renderPage();
    const dialog = await openMenuItem("Matomo Dashboards", "Remove");
    expect(dialog).toHaveTextContent("Remove Matomo Dashboards?");
    expect(dialog).toHaveTextContent("5 published dashboards use this instance. Tracking stops there.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(api.remove).toHaveBeenCalledWith("org-1", "a1");
    expect(api.mutate).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Matomo Dashboards removed.");
  });

  it("names only the instance when no dashboard uses it", async () => {
    renderPage();
    const dialog = await openMenuItem("Matomo Intern", "Remove");
    expect(dialog).toHaveTextContent("Remove Matomo Intern?");
    expect(dialog).toHaveTextContent("https://matomo.example.org/");
    expect(dialog).not.toHaveTextContent("Tracking stops");
  });

  it("says so when removing fails", async () => {
    api.remove.mockRejectedValue(new Error("500"));
    renderPage();
    const dialog = await openMenuItem("Matomo Intern", "Remove");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(toast.error).toHaveBeenCalledWith("Matomo Intern could not be removed.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows placeholders while the instances load, with the header and note at once", async () => {
    api.list = [];
    api.listLoading = true;
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Analytics" })).toBeInTheDocument();
    expect(screen.getByRole("note")).toBeInTheDocument();
    await expect(screen.getByRole("status", { name: "Loading" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("No Matomo instance yet")).toBeNull();
  });

  it("says when the instances could not be loaded and reads them again on retry", async () => {
    api.list = [];
    api.listError = new Error("500");
    renderPage();
    expect(screen.getByRole("note")).toBeInTheDocument();
    expect(screen.queryByText("No Matomo instance yet")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(api.mutate).toHaveBeenCalled();
  });

  it("claims no measured dashboards and offers no assignment while the dashboards load", async () => {
    api.dashboards = [];
    api.dashboardsLoading = true;
    renderPage();
    const card = screen.getByRole("article", { name: "Matomo Dashboards" });
    expect(card).not.toHaveTextContent("Measures");
    expect(within(card).getByRole("status", { name: "Loading" })).toBeInTheDocument();
    await expect(within(card).getByRole("button", { name: "Assign dashboards" })).toBeDisabled();
  });

  it("says in each card when the dashboards could not be loaded and reads them again on retry", async () => {
    api.dashboards = [];
    api.dashboardsError = new Error("500");
    renderPage();
    const card = screen.getByRole("article", { name: "Matomo Dashboards" });
    expect(card).not.toHaveTextContent("Measures no dashboard yet.");
    await expect(within(card).getByRole("button", { name: "Assign dashboards" })).toBeDisabled();
    await userEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(api.mutateDashboards).toHaveBeenCalled();
  });

  it("claims no measured dashboards while a failed dashboards read is tried again", async () => {
    // SWR keeps the error while it reads again, and is loading once more.
    api.dashboards = [];
    api.dashboardsError = new Error("500");
    api.dashboardsLoading = true;
    renderPage();
    const card = screen.getByRole("article", { name: "Matomo Dashboards" });
    expect(card).not.toHaveTextContent("Measures");
    expect(within(card).getByRole("status", { name: "Loading" })).toBeInTheDocument();
    await expect(within(card).getByRole("button", { name: "Assign dashboards" })).toBeDisabled();
  });

  it("waits for the organization before it reads or offers anything", () => {
    api.organizationId = undefined;
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Analytics" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText("No Matomo instance yet")).toBeNull();
    // No list yet, so neither the header nor the empty state offers to connect.
    expect(screen.queryByRole("button", { name: "Connect Matomo" })).toBeNull();
  });

  it("reads the dashboards again after a failed assignment and leaves out one that is gone", async () => {
    api.assign.mockRejectedValueOnce(new Error("422"));
    const { rerender } = renderPage();
    const dialog = await openAssign("Matomo Intern");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /^Radverkehr/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(toast.error).toHaveBeenCalledWith("The assignment could not be saved.");
    expect(api.mutateDashboards).toHaveBeenCalledWith();
    // The reread says Radverkehr is no longer published.
    api.dashboards = api.dashboards.filter((dashboard) => dashboard.project_id !== "p1");
    rerender(page());
    expect(within(dialog).queryByRole("checkbox", { name: /^Radverkehr/ })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(api.assign).toHaveBeenLastCalledWith("org-1", "a2", ["p6"]);
  });

  it("holds the assignment dialog while it saves", async () => {
    const saving = deferred<unknown[]>();
    api.assign.mockReturnValue(saving.promise);
    renderPage();
    const dialog = await openAssign("Matomo Intern");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    for (const box of within(dialog).getAllByRole("checkbox")) await expect(box).toBeDisabled();
    await expect(within(dialog).getByRole("textbox", { name: "Filter by name" })).toBeDisabled();
    await expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    saving.resolve([]);
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Dashboard assignment saved."));
  });

  it("holds the Matomo dialog while it saves", async () => {
    const saving = deferred<unknown>();
    api.update.mockReturnValue(saving.promise);
    renderPage();
    const dialog = await openMenuItem("Matomo Intern", "Edit");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    // Read only, not disabled: react-hook-form reads a disabled field as empty.
    for (const field of [/^Name/, /^Matomo URL/, /^Site ID/]) {
      const input = within(dialog).getByLabelText(field);
      await expect(input).toHaveAttribute("readonly");
      await expect(input).toHaveAttribute("aria-readonly", "true");
      await expect(input).toBeEnabled();
    }
    const provider = within(dialog).getByRole("combobox", { name: "Provider" });
    await expect(provider).toHaveAttribute("aria-readonly", "true");
    await userEvent.click(provider);
    expect(screen.queryByRole("listbox")).toBeNull();
    await expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    saving.resolve(undefined);
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Matomo saved."));
  });

  it("keeps every value through a failed save, also when the focused field loses the focus while saving", async () => {
    api.list = [];
    const saving = deferred<unknown>();
    api.create.mockReturnValueOnce(saving.promise);
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Connect Matomo" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText(/^Name/);
    const url = within(dialog).getByLabelText(/^Matomo URL/);
    const siteId = within(dialog).getByLabelText(/^Site ID/);
    await userEvent.type(name, "Matomo Dashboards");
    await userEvent.type(url, "https://matomo.example.org");
    await userEvent.type(siteId, "5");
    // Enter in a field submits through the footer's Save (the form's default
    // button) and leaves the focus in the field.
    fireEvent.submit(dialog.querySelector("form")!);
    await expect(siteId).toHaveFocus();
    // A browser may take the focus from a field it locks while saving.
    fireEvent.blur(siteId);
    saving.reject(new Error("500"));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("Matomo could not be saved."));
    await expect(name).toHaveValue("Matomo Dashboards");
    await expect(url).toHaveValue("https://matomo.example.org");
    await expect(siteId).toHaveValue("5");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.create).toHaveBeenLastCalledWith("org-1", {
      name: "Matomo Dashboards",
      provider: "matomo",
      config: { provider: "matomo", url: "https://matomo.example.org/", site_id: "5" },
    });
    expect(toast.success).toHaveBeenCalledWith("Matomo saved.");
  });
});
