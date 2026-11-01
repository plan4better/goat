import { ThemeProvider } from "@mui/material/styles";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import type { CreditBalance, StorageByLayer, StorageLayer } from "@/lib/api/usage";

import { StorageDetail } from "@/components/settings/usage/StorageDetail";

const api = vi.hoisted(() => ({
  storage: undefined as StorageByLayer | undefined,
  failing: false,
  layers: vi.fn(),
  download: vi.fn(),
}));

vi.mock("@/lib/api/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/usage")>()),
  useStorageLayers: (...args: unknown[]) => api.layers(...args),
  downloadStorageCsv: (...args: unknown[]) => api.download(...args),
}));
vi.mock("@/lib/api/users", () => ({ useOrganization: () => ({ organization: { id: "org1" } }) }));
vi.mock("@/lib/api/organizations", () => ({
  useOrganizationMembers: () => ({
    members: [
      { id: "u1", firstname: "Anna", lastname: "Weber", email: "anna@example.org", roles: [] },
      { id: "u2", firstname: "Tim", lastname: "Braun", email: "tim@example.org", roles: [] },
    ],
  }),
}));
vi.mock("@/components/support/SupportMenu", () => ({ useReportProblemHref: () => "/support/new" }));

const theme = createAppTheme({ mode: "light", locale: "en" });

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
  used_storage: 40960,
  total_storage: 51200,
  used_projects: 661,
  total_projects: 1000,
  used_editors: 3,
  total_editors: 10,
  used_viewers: 2,
  total_viewers: 50,
};

const layer = (i: number, values: Partial<StorageLayer> = {}): StorageLayer => ({
  layer_id: `l${i}`,
  name: `Layer ${i}`,
  size_mb: 2048 - i,
  geometry_type: "polygon",
  type: "feature",
  owner: "Anna Weber",
  owner_id: "u1",
  updated_at: "2026-11-19T12:00:00+00:00",
  projects: 2,
  ...values,
});

const PAGE: StorageByLayer = {
  rows: [
    layer(0),
    layer(1, { name: "Radwege", owner: "Tim Braun", owner_id: "u2", projects: 0 }),
    layer(2, { name: "Zensus", type: "table", geometry_type: null }),
    ...Array.from({ length: 7 }, (_, i) => layer(i + 3)),
  ],
  total: 48,
  trash: { count: 702, size_mb: 3174 },
  split: { in_projects_mb: 47309, unused_mb: 8704, trash_mb: 3174 },
};

/** The last request the detail made. */
const lastCall = () => api.layers.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;

const renderDetail = (balance: CreditBalance = BALANCE) =>
  render(<StorageDetail balance={balance} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ThemeProvider theme={theme}>
        <I18nextProvider i18n={commonI18n("en")}>{children}</I18nextProvider>
      </ThemeProvider>
    ),
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
  api.storage = PAGE;
  api.failing = false;
  api.layers.mockReset();
  api.layers.mockImplementation(() =>
    api.failing
      ? { storage: undefined, isLoading: false, isError: new Error("500") }
      : { storage: api.storage, isLoading: false, isError: undefined }
  );
  api.download.mockReset();
  api.download.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StorageDetail", () => {
  it("asks the server for one filtered page", async () => {
    renderDetail();
    expect(lastCall()).toEqual({ sort: "size", dir: "desc", limit: 10, offset: 0 });
    expect(screen.getByText("1–10 of 48 layers")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Not in any project" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(lastCall()).toEqual({ unused: true, sort: "size", dir: "desc", limit: 10, offset: 0 });
    expect(screen.getByTitle("Remove the filter Not in any project")).toBeInTheDocument();
  });

  it("filters by owner from a row", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Tim Braun" }));
    expect(screen.getByText("Owner: Tim Braun")).toBeInTheDocument();
    expect(lastCall()).toEqual(expect.objectContaining({ owner: "u2", offset: 0 }));
    // The owner pill names them too.
    expect(screen.getAllByRole("button", { name: "Tim Braun" }).length).toBeGreaterThan(1);
    await userEvent.click(screen.getByTitle("Remove the filter Owner: Tim Braun"));
    expect(lastCall()?.owner).toBeUndefined();
  });

  it("names a removed owner without offering them as a filter", () => {
    api.storage = {
      ...PAGE,
      rows: [layer(0, { name: "Altbestand", owner: null, owner_id: null })],
      total: 1,
    };
    renderDetail();
    const row = within(screen.getByRole("table")).getAllByRole("row")[1];
    expect(row).toHaveTextContent("Owner removed");
    expect(within(row).queryByRole("button", { name: "Owner removed" })).not.toBeInTheDocument();
  });

  it("filters by owner and type from the pills", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "All owners" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Anna Weber/ }));
    await userEvent.click(screen.getByRole("button", { name: "All types" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Points" }));
    expect(lastCall()).toEqual(expect.objectContaining({ owner: "u1", type: "point", offset: 0 }));
    expect(screen.getByText("Owner: Anna Weber")).toBeInTheDocument();
    expect(screen.getByText("Type: Points")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(lastCall()).toEqual({ sort: "size", dir: "desc", limit: 10, offset: 0 });
  });

  it("tags unused layers", () => {
    renderDetail();
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows[1]).toHaveTextContent("Radwege");
    expect(within(rows[1]).getByText("Unused")).toBeInTheDocument();
    expect(within(rows[0]).queryByText("Unused")).not.toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("Polygons");
    expect(rows[0]).toHaveTextContent("2 days ago");
    expect(rows[0]).toHaveTextContent("2 GB");
    expect(rows[2]).toHaveTextContent("Table");
  });

  it("splits the storage into projects, no project and the trash", () => {
    renderDetail();
    expect(
      screen.getByRole("img", {
        name: "In projects 46.2 GB, Not in any project 8.5 GB, Trash 3.1 GB, 702 layers",
      })
    ).toBeInTheDocument();
    expect(screen.getByText("40 GB")).toBeInTheDocument();
    expect(screen.getByText("out of 50 GB.")).toBeInTheDocument();
    expect(
      screen.getByText("Over the limit, new datasets can't be uploaded until storage is below it again.", {
        exact: false,
      })
    ).toBeInTheDocument();
  });

  it("shows the over-limit callout with the trash amount", () => {
    renderDetail({ ...BALANCE, used_storage: 60000 });
    expect(screen.getByText("out of 50 GB. Over the limit by 8.6 GB.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Storage is over the limit, so new datasets can't be uploaded until it is below the limit again. Deleting layers that are not in any project frees space, and the 3.1 GB in the trash are freed within 30 days."
    );
    expect(
      within(screen.getByRole("status")).getByRole("link", { name: "Ask for more" })
    ).toBeInTheDocument();
    // The callout takes the place of the limit line.
    expect(screen.queryByText(/^Over the limit, new datasets/)).not.toBeInTheDocument();
  });

  it("leaves the trash out of the callout when it is empty", () => {
    api.storage = { ...PAGE, trash: { count: 0, size_mb: 0 } };
    renderDetail({ ...BALANCE, used_storage: 60000 });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Storage is over the limit, so new datasets can't be uploaded until it is below the limit again. Deleting layers that are not in any project frees space."
    );
  });

  it("starts again on page 1 when a filter changes", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Go to page 4" }));
    expect(lastCall()).toEqual(expect.objectContaining({ offset: 30 }));
    await userEvent.click(screen.getByRole("button", { name: "Not in any project" }));
    expect(lastCall()).toEqual(expect.objectContaining({ unused: true, offset: 0 }));
    await userEvent.click(screen.getByRole("button", { name: "Go to page 2" }));
    await userEvent.click(screen.getByRole("button", { name: /^Projects/ }));
    expect(lastCall()).toEqual(expect.objectContaining({ sort: "projects", dir: "desc", offset: 0 }));
    await userEvent.click(screen.getByRole("button", { name: "Go to page 2" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Search layers" }), "Rad");
    await waitFor(() => expect(lastCall()).toEqual(expect.objectContaining({ q: "Rad", offset: 0 })));
    expect(screen.getByText("Search: Rad")).toBeInTheDocument();
  });

  it("exports every matching layer in the list's order", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Not in any project" }));
    await userEvent.click(screen.getByRole("button", { name: /^Layer/ }));
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(api.download).toHaveBeenCalledWith({
      q: undefined,
      owner: undefined,
      type: undefined,
      unused: true,
      sort: "name",
      dir: "asc",
    });
  });

  it("says so when the layers cannot be read", () => {
    api.failing = true;
    renderDetail();
    expect(screen.getByRole("alert")).toHaveTextContent("Usage could not be loaded. Please reload the page.");
    // The header and the way to other filters stay.
    expect(screen.getByText("40 GB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not in any project" })).toBeInTheDocument();
  });

  it("tells an organization without layers where they come from", () => {
    api.storage = { ...PAGE, rows: [], total: 0 };
    renderDetail({ ...BALANCE, used_storage: 0 });
    expect(screen.getByText("No layers yet")).toBeInTheDocument();
  });
});
