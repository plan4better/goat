import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import type { CustomDomain } from "@/lib/validations/customDomain";

import { DeleteDomainDialog } from "@/components/settings/whiteLabel/DeleteDomainDialog";

vi.mock("react-toastify", () => ({ toast: { error: vi.fn() } }));

const DOMAIN = {
  id: "d1",
  base_domain: "karten.stadt.example",
  dns_status: "verified",
  cert_status: "active",
  assigned_project_id: "p1",
  assigned_project_name: "Radverkehr",
} as CustomDomain;

const renderDialog = (domain: CustomDomain, onConfirm = vi.fn().mockResolvedValue(undefined)) => {
  render(
    <I18nextProvider i18n={commonI18n("en")}>
      <DeleteDomainDialog domain={domain} onClose={vi.fn()} onConfirm={onConfirm} />
    </I18nextProvider>
  );
  return onConfirm;
};

describe("DeleteDomainDialog", () => {
  it("warns that an assigned dashboard goes offline at once", async () => {
    const onConfirm = renderDialog(DOMAIN);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("You are deleting karten.stadt.example.");
    expect(dialog).toHaveTextContent("The domain is assigned to Radverkehr.");
    expect(dialog).toHaveTextContent("The SSL certificate is removed.");
    await userEvent.click(screen.getByRole("button", { name: "Delete domain" }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("says a free domain is assigned to nothing", () => {
    renderDialog({ ...DOMAIN, assigned_project_id: null, assigned_project_name: null });
    expect(screen.getByRole("dialog")).toHaveTextContent("The domain is not assigned to a project.");
  });
});
