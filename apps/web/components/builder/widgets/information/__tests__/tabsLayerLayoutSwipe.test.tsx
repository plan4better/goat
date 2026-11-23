import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MapLayer } from "@/hooks/map/useMapLayers";

/**
 * Group-swipe on the tabs layer layout (mobile dashboard).
 *
 * On phones the layers widget lives inside a horizontal Swiper that pages
 * between dashboard panels, so the widget marks itself `swiper-no-swiping`
 * and handles the horizontal gesture itself to move between groups.
 *
 * These tests pin the gesture's discrimination rules — a long-enough,
 * horizontally-dominant swipe switches groups; a tap, a short drag, a vertical
 * scroll, and a swipe past either end must not.
 */

const dispatch = vi.fn();

vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => dispatch,
  useAppSelector: () => undefined,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-toastify", () => ({ toast: { error: vi.fn() } }));

// ProjectLayerTree drags in react-map-gl and the whole layer stack; the swipe
// behaviour under test doesn't depend on any of it. Render the layer names so
// the assertions can see which group is active.
vi.mock("@/components/map/panels/layer/ProjectLayerTree", () => ({
  ProjectLayerTree: ({ projectLayers }: { projectLayers: { name: string }[] }) => (
    <div data-testid="tree">{projectLayers.map((l) => l.name).join(",")}</div>
  ),
  VisibilityToggle: () => <span />,
}));

vi.mock("@/components/map/panels/style/other/MaskedImageIcon", () => ({
  MaskedImageIcon: () => <span />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let TabsLayerLayout: any;

const GROUPS = [
  { id: 1, name: "Verkehr", parent_id: null, order: 0 },
  { id: 2, name: "Parken", parent_id: null, order: 1 },
  { id: 3, name: "Baustellen", parent_id: null, order: 2 },
];

const layer = (id: number, name: string, group: number) =>
  ({ id, name, layer_project_group_id: group, type: "feature", visible: true, entry: { type: "layer", id }, style: null }) as unknown as MapLayer;
const LAYERS = [layer(11, "Stau", 1), layer(21, "Parkhaus", 2), layer(31, "Sperrung", 3)];

function renderLayout() {
  return render(
    <TabsLayerLayout
      projectId="p1"
      projectLayers={LAYERS}
      projectLayerGroups={GROUPS}
      config={{ type: "layers", options: { layout_style: "tabs" } }}
      onLayerStateChange={vi.fn()}
    />
  );
}

/** Dispatch a touch gesture across the swipe surface (the tree wrapper). */
function swipe(dx: number, dy: number) {
  const surface = screen.getByTestId("tree").parentElement!;
  fireEvent.touchStart(surface, { touches: [{ clientX: 200, clientY: 300 }] });
  fireEvent.touchEnd(surface, {
    changedTouches: [{ clientX: 200 + dx, clientY: 300 + dy }],
  });
}

const activeGroupLayers = () => screen.getByTestId("tree").textContent;

describe("TabsLayerLayout — swipe between layer groups", () => {
  beforeEach(async () => {
    dispatch.mockClear();
    if (!TabsLayerLayout) {
      TabsLayerLayout = (
        await import("@/components/builder/widgets/information/TabsLayerLayout")
      ).default;
    }
  });

  it("opts out of the parent panel Swiper so the gesture reaches this widget", () => {
    const { container } = renderLayout();
    expect(container.querySelector(".swiper-no-swiping")).not.toBeNull();
  });

  it("swiping left advances to the next group", () => {
    renderLayout();
    expect(activeGroupLayers()).toBe("Stau");
    swipe(-80, 0);
    expect(activeGroupLayers()).toBe("Parkhaus");
  });

  it("swiping right returns to the previous group", () => {
    renderLayout();
    swipe(-80, 0);
    swipe(80, 0);
    expect(activeGroupLayers()).toBe("Stau");
  });

  it("emits group_activated for the group swiped to", () => {
    renderLayout();
    swipe(-80, 0);
    const emitted = dispatch.mock.calls.map(([action]) => action?.payload);
    expect(emitted).toContainEqual(expect.objectContaining({ type: "group_activated", sourceId: 2 }));
  });

  it("ignores a tap", () => {
    renderLayout();
    swipe(0, 0);
    expect(activeGroupLayers()).toBe("Stau");
  });

  it("ignores a drag shorter than the threshold", () => {
    renderLayout();
    swipe(-30, 0);
    expect(activeGroupLayers()).toBe("Stau");
  });

  it("ignores a vertical scroll, even a long one", () => {
    renderLayout();
    // Vertical dominates: scrolling a long layer list must never change group
    swipe(-50, -200);
    expect(activeGroupLayers()).toBe("Stau");
  });

  it("does not wrap around past the first group", () => {
    renderLayout();
    swipe(80, 0);
    expect(activeGroupLayers()).toBe("Stau");
  });

  it("does not wrap around past the last group", () => {
    renderLayout();
    swipe(-80, 0);
    swipe(-80, 0);
    expect(activeGroupLayers()).toBe("Sperrung");
    swipe(-80, 0);
    expect(activeGroupLayers()).toBe("Sperrung");
  });
});
