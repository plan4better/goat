import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import SettingsLayout from "@/app/(dashboard)/settings/layout";

const state = vi.hoisted(() => ({ pathname: "/settings/account" }));

vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("@/lib/api/users", () => ({ useFeatures: () => ({ features: { billing: true } }) }));
vi.mock("@/hooks/auth/AuthZ", () => ({ useAuthZ: () => ({ isOrgAdmin: true, isLoading: false }) }));

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

describe("SettingsLayout", () => {
  beforeEach(() => {
    state.pathname = "/settings/account";
  });

  it("lays the usage page on the page background, with its own header", () => {
    renderAt("/settings/usage");
    expect(screen.getByText("page body").closest(".MuiPaper-root")).toBeNull();
  });

  it("keeps every other settings page on its card", () => {
    renderAt("/settings/account");
    expect(screen.getByText("page body").closest(".MuiPaper-root")).not.toBeNull();
    renderAt("/settings/organization/members");
    expect(screen.getAllByText("page body")[1].closest(".MuiPaper-root")).not.toBeNull();
  });
});
