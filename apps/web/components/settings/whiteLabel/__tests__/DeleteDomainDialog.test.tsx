import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CustomDomain } from "@/lib/validations/customDomain";

import { DeleteDomainDialog } from "@/components/settings/whiteLabel/DeleteDomainDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
  Trans: ({ values }: { values?: Record<string, unknown> }) => (
    <span>{String(Object.values(values ?? {})[0] ?? "")}</span>
  ),
}));
vi.mock("react-toastify", () => ({ toast: { error: vi.fn() } }));

const domain: CustomDomain = {
  id: "5f6e3c9a-1111-4b1a-8a1a-000000000001",
  organization_id: "5f6e3c9a-1111-4b1a-8a1a-000000000002",
  base_domain: "dashboards.example.com",
  kind: "single",
  dns_status: "verified",
  dns_status_message: null,
  dns_last_checked_at: null,
  cert_status: "active",
  cert_status_message: null,
  created_at: "2026-01-01T00:00:00Z",
};

describe("DeleteDomainDialog", () => {
  it("shows the title and the unassigned Delete label", () => {
    render(
      <DeleteDomainDialog
        open
        domain={domain}
        onClose={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText("Delete custom domain")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("switches to the heavier assigned copy and label when a project is assigned", () => {
    render(
      <DeleteDomainDialog
        open
        domain={domain}
        assignedProjectName="City Dashboard"
        onClose={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByRole("button", { name: "Delete domain" })).toBeInTheDocument();
    expect(screen.getByText(/City Dashboard/)).toBeInTheDocument();
  });

  it("blocks Cancel and the header close while the confirm is in flight", async () => {
    let resolveConfirm: () => void = () => undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        })
    );
    const onClose = vi.fn();
    render(<DeleteDomainDialog open domain={domain} onClose={onClose} onConfirm={onConfirm} />);

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect((screen.getByRole("button", { name: "cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "close" }) as HTMLButtonElement).disabled).toBe(true);

    resolveConfirm();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "cancel" }) as HTMLButtonElement).disabled).toBe(false)
    );
  });
});
