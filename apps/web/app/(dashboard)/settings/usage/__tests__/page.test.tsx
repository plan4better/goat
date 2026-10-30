import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import UsagePage from "../page";

const { features } = vi.hoisted(() => ({
  features: { value: { features: undefined, isError: undefined } as { features: unknown; isError: unknown } },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/api/users", () => ({ useFeatures: () => features.value }));
vi.mock("@/components/settings/usage/UsageOverview", () => ({ UsageOverview: () => <div>overview</div> }));
vi.mock("@/components/settings/usage/UsageActivity", () => ({ UsageActivity: () => <div>activity</div> }));

describe("UsagePage", () => {
  beforeEach(() => {
    features.value = { features: undefined, isError: undefined };
  });

  it("renders nothing while the feature flags load", () => {
    const { container } = render(<UsagePage />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an error when the feature flags fail to load", () => {
    features.value = { features: undefined, isError: new Error("500") };
    render(<UsagePage />);
    expect(screen.getByText("usage_load_error")).toBeInTheDocument();
  });

  it("shows the usage tabs when billing is on", () => {
    features.value = { features: { billing: true }, isError: undefined };
    render(<UsagePage />);
    expect(screen.getByRole("tab", { name: "overview" })).toBeInTheDocument();
  });
});
