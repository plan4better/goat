import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UsageOverview } from "./UsageOverview";

// Mock i18next
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => {
      if (opts?.remaining !== undefined) return `${opts.remaining} credits remaining`;
      return k;
    },
  }),
  Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, unknown> }) => {
    if (i18nKey === "common:current_credits_out_of_total_quota" && values) {
      return <span>{`${values.current} out of ${values.total} credits`}</span>;
    }
    if (i18nKey === "common:current_storage_out_of_total_quota" && values) {
      return <span>{`${values.current} out of ${values.total}`}</span>;
    }
    if (i18nKey === "common:current_projects_out_of_total_quota" && values) {
      return <span>{`${values.current} out of ${values.total} projects`}</span>;
    }
    if (i18nKey === "common:editors_quota_label" && values) {
      return <span>{`${values.current} editors out of ${values.total}`}</span>;
    }
    return <span>{i18nKey}</span>;
  },
}));

// Mock MUI theme
vi.mock("@mui/material", async () => {
  const actual = await vi.importActual<typeof import("@mui/material")>("@mui/material");
  return {
    ...actual,
    useTheme: () => ({
      palette: {
        primary: { main: "#1976d2" },
        info: { main: "#0288d1" },
        warning: { main: "#ed6c02" },
      },
    }),
  };
});

const mockBalance = {
  used_credits: 3030,
  total_credits: 5000,
  over_budget: false,
  plan_renewal_date: "2026-07-01T00:00:00",
  used_storage: 512,
  total_storage: 10240,
  used_projects: 3,
  total_projects: 20,
  used_editors: 2,
  total_editors: 5,
  used_viewers: 0,
  total_viewers: null,
};

const mockBreakdown = {
  group_by: "category",
  rows: [
    { key: "compute", credits: 20.0, units: 4200, count: 7 },
    { key: "egress", credits: 10.0, units: 5_368_709_120, count: 3 },
  ],
};

const mockStorage = {
  rows: [
    { layer_id: "abc", name: "Layer A", size_mb: 100, geometry_type: "point", owner: "user@example.com" },
  ],
};

vi.mock("@/lib/api/usage", () => ({
  useCreditBalance: () => ({ balance: mockBalance, isLoading: false, isError: null }),
  useCreditBreakdown: () => ({ breakdown: mockBreakdown, isLoading: false, isError: null }),
  useStorageByLayer: () => ({ storage: mockStorage, isLoading: false, isError: null }),
}));

describe("UsageOverview", () => {
  it("renders the credit budget used value", () => {
    render(<UsageOverview />);
    // Budget row renders used/total as adjacent text nodes in one element; t() returns keys as-is
    expect(screen.getByText(/3030\.00/)).toBeInTheDocument();
    expect(screen.getByText(/5000\.00/)).toBeInTheDocument();
  });

  it("renders capacity labels for storage and projects", () => {
    render(<UsageOverview />);
    expect(screen.getByText(/512 MB out of 10240 MB/i)).toBeInTheDocument();
    expect(screen.getByText(/3 out of 20 projects/i)).toBeInTheDocument();
  });

  it("renders compute and traffic native stats", () => {
    render(<UsageOverview />);
    // 4200 seconds / 60 = 70 min — rendered as the h5 stat value
    const computeEls = screen.getAllByText(/^70$/);
    expect(computeEls.length).toBeGreaterThan(0);
    // 5368709120 bytes / 1_000_000_000 = 5.37 GB
    const trafficEls = screen.getAllByText(/5\.37/);
    expect(trafficEls.length).toBeGreaterThan(0);
  });

  it("renders the storage by layer list", () => {
    render(<UsageOverview />);
    expect(screen.getByText("Layer A")).toBeInTheDocument();
  });
});
