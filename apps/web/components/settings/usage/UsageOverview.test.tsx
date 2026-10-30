import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UsageOverview } from "./UsageOverview";

const state = vi.hoisted(() => ({
  admin: true,
  storageError: undefined as unknown,
  balance: undefined as Record<string, unknown> | undefined,
  storageEnabled: undefined as boolean | undefined,
}));

// Mock i18next
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => {
      if (opts?.remaining !== undefined)
        return `${opts.remaining} credits remaining, ${opts.gb} GB, ${opts.minutes} min`;
      if (opts?.rate !== undefined) return `${k} ${opts.rate}`;
      return k;
    },
    i18n: { language: "en" },
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
  used_credits: 3030.4,
  total_credits: 5000,
  over_budget: false,
  plan_renewal_date: "2026-07-01T00:00:00",
  on_trial: false,
  credits_reset_at: "2026-07-01T00:00:00",
  used_storage: 512,
  total_storage: 10240,
  used_projects: 3,
  total_projects: 20,
  used_editors: 2,
  total_editors: 5,
  used_viewers: 0,
  total_viewers: null,
  rates: [
    { category: "compute", rate: 0.5, unit_basis: "minute" },
    { category: "egress", rate: 4, unit_basis: "GB" },
  ],
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
  useCreditBalance: () => ({ balance: state.balance ?? mockBalance, isLoading: false, isError: null }),
  useCreditBreakdown: () => ({ breakdown: mockBreakdown, isLoading: false, isError: null }),
  useStorageByLayer: (enabled?: boolean) => {
    state.storageEnabled = enabled;
    return {
      storage: enabled === false || state.storageError ? undefined : mockStorage,
      isLoading: false,
      isError: state.storageError,
    };
  },
}));
vi.mock("@/hooks/auth/AuthZ", () => ({ useAuthZ: () => ({ isOrgAdmin: state.admin }) }));

describe("UsageOverview", () => {
  beforeEach(() => {
    state.admin = true;
    state.storageError = undefined;
    state.balance = undefined;
    state.storageEnabled = undefined;
  });

  it("renders the credit budget used value", () => {
    render(<UsageOverview />);
    // Budget row renders used/total as adjacent text nodes in one element; t() returns keys as-is.
    // Credits are shown as whole numbers, the ledger's fractions rounded away.
    expect(screen.getByText(/3,030 out_of 5,000/)).toBeInTheDocument();
    expect(screen.queryByText(/3030\.4/)).not.toBeInTheDocument();
  });

  it("renders capacity labels for storage and projects", () => {
    render(<UsageOverview />);
    expect(screen.getByText(/512 MB out of 10 GB/i)).toBeInTheDocument();
    expect(screen.getByText(/3 out of 20 projects/i)).toBeInTheDocument();
  });

  it("renders compute and traffic native stats", () => {
    render(<UsageOverview />);
    // 4200 seconds = 70 minutes, with its unit (t() returns the key)
    const computeEls = screen.getAllByText(/^70 minutes_abbr$/);
    expect(computeEls.length).toBeGreaterThan(0);
    // 5368709120 bytes = 5.4 GB (decimal, as charged)
    const trafficEls = screen.getAllByText(/5\.4 GB/);
    expect(trafficEls.length).toBeGreaterThan(0);
  });

  it("renders the storage by layer list", () => {
    render(<UsageOverview />);
    expect(screen.getByText("Layer A")).toBeInTheDocument();
  });

  it("hides the storage list from non-admins and does not request it", () => {
    state.admin = false;
    render(<UsageOverview />);
    expect(screen.queryByText("Layer A")).not.toBeInTheDocument();
    expect(state.storageEnabled).toBe(false);
    // the rest of the page still renders
    expect(screen.getByText(/3 out of 20 projects/i)).toBeInTheDocument();
  });

  it("hides the storage list quietly when the request fails (403)", () => {
    state.storageError = Object.assign(new Error("forbidden"), { status: 403 });
    render(<UsageOverview />);
    expect(screen.queryByText("Layer A")).not.toBeInTheDocument();
    expect(screen.getByText(/3 out of 20 projects/i)).toBeInTheDocument();
  });

  it("converts what is left with the server's rates", () => {
    // 5000 - 3030.4 = 1969.6 left; /4 credits per GB, /0.5 per minute
    render(<UsageOverview />);
    expect(screen.getByText("1,970 credits remaining, 492 GB, 3,939 min")).toBeInTheDocument();
  });

  it("shows a rate unrounded", () => {
    render(<UsageOverview />);
    expect(screen.getByText("credit_pricing_compute 0.5")).toBeInTheDocument();
  });

  it("clamps an over-budget balance to zero and says the credits are used up", () => {
    state.balance = { ...mockBalance, used_credits: 5120, total_credits: 5000, over_budget: true };
    render(<UsageOverview />);
    expect(screen.getByText(/· 0 remaining/)).toBeInTheDocument();
    expect(screen.queryByText(/-120/)).not.toBeInTheDocument();
    expect(screen.getByText("credits_used_up")).toBeInTheDocument();
    expect(screen.queryByText(/credits remaining/)).not.toBeInTheDocument();
  });
});
