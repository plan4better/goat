import { render } from "@testing-library/react";
import { type ReactElement, cloneElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { PieChartSchema } from "@/lib/validations/widget";

import { PieChartWidget } from "@/components/builder/widgets/chart/Pie";

const { t } = vi.hoisted(() => ({ t: (key: string) => key }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t, i18n: { language: "en" } }),
}));
// jsdom has no layout, so ResponsiveContainer would measure 0×0 and draw nothing.
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: ({ children }: { children: ReactElement }) =>
    cloneElement(children, { width: 400, height: 280 } as Record<string, unknown>),
}));
vi.mock("@/hooks/map/DashboardBuilderHooks", () => ({
  useChartWidget: (config: PieChartSchema) => ({
    config,
    queryParams: { group_by_column_name: "carrier" },
    layerId: "layer-1",
    isLayerLocked: false,
  }),
}));
vi.mock("@/lib/api/projects", () => ({
  useProjectLayerAggregationStats: () => ({
    aggregationStats: {
      items: [
        { grouped_value: "Erdgas", operation_value: 60 },
        { grouped_value: "Heizöl", operation_value: 30 },
        { grouped_value: "Strom", operation_value: 10 },
      ],
    },
    isLoading: false,
    isError: false,
  }),
}));

const pieConfig = (chartType: "donut" | "half_donut") =>
  ({
    type: "pie",
    setup: { layer_project_id: 1, operation_type: "count", group_by_field: "carrier" },
    options: { chart_type: chartType, layout: "center_active", label_size: "sm" },
  }) as unknown as PieChartSchema;

const svgText = (container: HTMLElement) =>
  [...container.querySelectorAll("svg text")].map((node) => node.textContent ?? "");

describe("Pie chart, Center active layout", () => {
  it.each(["donut", "half_donut"] as const)("shows the active slice's share and name inside a %s", (type) => {
    const { container } = render(<PieChartWidget config={pieConfig(type)} />);

    const texts = svgText(container);
    expect(texts).toContain("60.0%");
    expect(texts.join(" ")).toContain("Erdgas");
  });
});
