import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import AnalyticsPage from "@/app/(dashboard)/settings/analytics/page";

vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/settings/useOrganizationId", () => ({ useOrganizationId: () => "org-1" }));
vi.mock("@/lib/api/organizationAnalytics", () => ({
  useOrganizationAnalytics: () => ({
    analyticsList: [],
    isLoading: false,
    isError: undefined,
    mutate: vi.fn(),
  }),
  useOrganizationAnalyticsDashboards: () => ({
    dashboards: [],
    isLoading: false,
    isError: undefined,
    mutate: vi.fn(),
  }),
}));
// Code a deploy removed (a tab opened before it): every load of it fails.
vi.mock("@/components/settings/analytics/MatomoDialog", () => {
  throw new Error("Failed to load chunk");
});

describe("Analytics page when a dialog's code does not load", () => {
  it("shows a notice in place of the dialog instead of failing the page", async () => {
    render(
      <I18nextProvider i18n={commonI18n("en")}>
        <AnalyticsPage />
      </I18nextProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect Matomo" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("This part could not be loaded.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "Analytics" })).toBeInTheDocument();
  });
});
