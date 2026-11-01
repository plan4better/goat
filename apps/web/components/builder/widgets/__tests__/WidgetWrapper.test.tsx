/**
 * A widget that fails to render takes only itself down: before, the error
 * unmounted the whole project page.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuilderWidgetSchema } from "@/lib/validations/project";

import WidgetWrapper from "@/components/builder/widgets/WidgetWrapper";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: (select: (state: unknown) => unknown) =>
    select({ map: { selectedBuilderItem: undefined, temporaryFilters: [] } }),
}));
vi.mock("@/components/builder/widgets/chart/WidgetChart", () => ({
  default: ({ config }: { config: { options?: { broken?: boolean } } }) => {
    if (config.options?.broken) throw new Error("bad widget config");
    return <p>chart</p>;
  },
}));
vi.mock("@/components/builder/widgets/elements/WidgetElement", () => ({ default: () => <p>divider</p> }));
vi.mock("@/components/builder/widgets/data/WidgetData", () => ({ default: () => null }));
vi.mock("@/components/builder/widgets/information/WidgetInformation", () => ({ default: () => null }));

const chart = (broken: boolean) =>
  ({
    id: "w-chart",
    type: "widget",
    config: { type: "histogram_chart", options: { broken } },
  }) as unknown as BuilderWidgetSchema;
const divider = {
  id: "w-divider",
  type: "widget",
  config: { type: "divider" },
} as unknown as BuilderWidgetSchema;

const renderPanel = (viewOnly: boolean, broken = true) =>
  render(
    <div>
      <WidgetWrapper widget={chart(broken)} projectLayers={[]} projectLayerGroups={[]} viewOnly={viewOnly} />
      <WidgetWrapper widget={divider} projectLayers={[]} projectLayerGroups={[]} viewOnly={viewOnly} />
    </div>
  );

describe("a widget that fails to render", () => {
  beforeEach(() => {
    // React reports the caught error on the console; keep the test output clean.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says so in the editor, where it can still be selected and deleted, and the rest renders", () => {
    renderPanel(false);
    expect(screen.getByText("widget_cannot_be_shown")).toBeInTheDocument();
    expect(screen.getByText("divider")).toBeInTheDocument();
  });

  it("is left out of the published dashboard, and the rest renders", () => {
    renderPanel(true);
    expect(screen.queryByText("widget_cannot_be_shown")).toBeNull();
    expect(screen.getByText("divider")).toBeInTheDocument();
  });

  it("renders again once its config changes", () => {
    const { rerender } = renderPanel(false);
    rerender(
      <div>
        <WidgetWrapper widget={chart(false)} projectLayers={[]} projectLayerGroups={[]} viewOnly={false} />
        <WidgetWrapper widget={divider} projectLayers={[]} projectLayerGroups={[]} viewOnly={false} />
      </div>
    );
    expect(screen.getByText("chart")).toBeInTheDocument();
    expect(screen.queryByText("widget_cannot_be_shown")).toBeNull();
  });
});
