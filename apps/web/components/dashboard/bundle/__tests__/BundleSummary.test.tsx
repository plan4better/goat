/**
 * The Update button is the only way back for a bundle whose artifacts are
 * unusable — including one that holds no artifact row at all. `failed` rows
 * predating the self-deleting import are left in the table on purpose, and an
 * import worker killed outright never reaches that delete either, so such a
 * bundle sits at `processing` with nothing derived and no other action.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BundleArtifact, BundleRead } from "@/lib/api/bundles";

import BundleSummary from "@/components/dashboard/bundle/BundleSummary";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", exists: () => false },
  }),
}));
vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => [],
}));
vi.mock("@/hooks/map/DatasetHooks", () => ({
  useGetMetadataValueTranslation: () => (_key: string, value: string) => value,
}));
vi.mock("@/i18n/utils", () => ({ useDateFnsLocale: () => undefined }));
vi.mock("@/lib/api/bundleEdits", () => ({ rebuildBundleArtifact: vi.fn() }));

const bundle = (overrides: Partial<BundleRead> = {}): BundleRead =>
  ({
    id: "bundle-1",
    name: "Munich",
    folder_id: "folder-1",
    bundle_type: "street_network",
    // A street network's artifacts are derived from its member layers, which is
    // what makes a rebuild possible at all — the gate the panel reads.
    artifacts_from_layers: true,
    status: "ready",
    artifacts: [],
    ...overrides,
  }) as BundleRead;

const artifact = (state: BundleArtifact["state"]): BundleArtifact =>
  ({ kind: "routing_network", state, build_status: "complete" }) as BundleArtifact;

const updateButton = () => screen.queryByRole("button", { name: "update_bundle" });

describe("BundleSummary", () => {
  it("offers no rebuild for a ready bundle", () => {
    render(<BundleSummary bundle={bundle({ artifacts: [artifact("ready")] })} />);

    expect(updateButton()).toBeNull();
  });

  it("offers a rebuild when an artifact is unusable", () => {
    render(<BundleSummary bundle={bundle({ artifacts: [artifact("failed")] })} />);

    expect(updateButton()).not.toBeNull();
  });

  it("offers a rebuild for a legacy failed bundle with no artifacts", () => {
    render(<BundleSummary bundle={bundle({ status: "failed", artifacts: [] })} />);

    expect(updateButton()).not.toBeNull();
  });

  it("offers a rebuild for a bundle left mid-import with no artifacts", () => {
    render(<BundleSummary bundle={bundle({ status: "processing", artifacts: [] })} />);

    expect(updateButton()).not.toBeNull();
  });

  it("offers none to a bundle whose import finished without deriving one", () => {
    render(<BundleSummary bundle={bundle({ status: "ready", artifacts: [] })} />);

    expect(updateButton()).toBeNull();
  });
});
