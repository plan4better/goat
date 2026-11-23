import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import CatalogSignInHint from "@/components/dashboard/catalog/CatalogSignInHint";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/catalog/abc",
  useSearchParams: () => new URLSearchParams("tab=data"),
}));

describe("CatalogSignInHint", () => {
  it("is one line that leads to the sign-in and back to this page", () => {
    render(<CatalogSignInHint />);

    const link = screen.getByRole("link", { name: "catalog_sign_in_to_see_data" });
    expect(link.getAttribute("href")).toBe(
      `/auth/login?callbackUrl=${encodeURIComponent("/catalog/abc?tab=data")}`
    );
  });
});
