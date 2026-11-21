import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { DropdownMenu } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import {
  type PopoverEntry,
  type PopoverLevel,
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { NavRow } from "@/components/map/panels/styleEditor/rows";

import { renderPanel } from "./renderPanel";

const entry = (key: string, render: () => React.ReactNode = () => <p>{key} content</p>): PopoverEntry => ({
  key,
  title: `${key} title`,
  anchorTop: 120,
  render,
});

function Harness({ entries }: { entries: Array<[PopoverLevel, PopoverEntry]> }) {
  const popover = usePopover();
  return (
    <>
      {entries.map(([level, e]) => (
        <button key={`${level}-${e.key}`} onClick={() => popover.open(level, e)}>
          open {e.key}
        </button>
      ))}
    </>
  );
}

const renderStack = (entries: Array<[PopoverLevel, PopoverEntry]>) =>
  renderPanel(
    <PopoverProvider>
      <Harness entries={entries} />
    </PopoverProvider>
  );

describe("popovers", () => {
  it("closed popovers render nothing", async () => {
    const render = vi.fn(() => <p>fill content</p>);
    renderStack([[1, entry("fill", render)]]);
    expect(render).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("open fill"));
    expect(screen.getByText("fill content")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.close" }));
    expect(screen.queryByText("fill content")).toBeNull();
  });

  it("level 2 keeps level 1 open", async () => {
    renderStack([
      [1, entry("fill")],
      [2, entry("palette")],
    ]);
    await userEvent.click(screen.getByText("open fill"));
    await userEvent.click(screen.getByText("open palette"));
    expect(screen.getByText("fill content")).toBeDefined();
    expect(screen.getByText("palette content")).toBeDefined();
  });

  it("an editor opened from level 2 opens beside it as level 3; closing a level closes the levels it opened", async () => {
    function Level({ name, next }: { name: string; next?: () => PopoverEntry }) {
      const popover = usePopover();
      const level = useNextLevel();
      return (
        <>
          <p>{name} content</p>
          {next && <button onClick={() => popover.open(level, next())}>open from {name}</button>}
        </>
      );
    }
    const color = entry("color", () => <Level name="color" />);
    const classes = entry("classes", () => <Level name="classes" next={() => color} />);
    const fill = entry("fill", () => <Level name="fill" next={() => classes} />);
    renderPanel(
      <div data-style-panel>
        <PopoverProvider>
          <Harness entries={[[1, fill]]} />
        </PopoverProvider>
      </div>
    );
    await userEvent.click(screen.getByText("open fill"));
    await userEvent.click(screen.getByText("open from fill"));
    await userEvent.click(screen.getByText("open from classes"));
    const frames = () => Array.from(document.querySelectorAll<HTMLElement>("[data-popover-frame]"));
    expect(frames().map((f) => f.dataset.popoverLevel)).toEqual(["1", "2", "3"]);
    expect(screen.queryByRole("button", { name: "style_editor.back_to" })).toBeNull();
    // Each level left of the one that opened it, all three shown.
    const left = (text: string) =>
      parseFloat(
        (screen.getByText(text).closest("[data-popover-frame]")!.parentElement as HTMLElement).style.left
      );
    expect(left("color content")).toBeLessThanOrEqual(left("classes content"));
    expect(left("classes content")).toBeLessThanOrEqual(left("fill content"));
    // Level 2's close button closes it and level 3.
    const level2 = frames()[1];
    await userEvent.click(within(level2).getByRole("button", { name: "style_editor.close" }));
    expect(screen.queryByText("classes content")).toBeNull();
    expect(screen.queryByText("color content")).toBeNull();
    expect(screen.getByText("fill content")).toBeDefined();
  });

  it("Escape closes picker, then level 2, then level 1", async () => {
    // The picker opens from level 2, the deepest open level, so all three are open.
    function Classes() {
      const popover = usePopover();
      return (
        <>
          <p>classes content</p>
          <button onClick={() => popover.open("picker", entry("color"))}>open color</button>
        </>
      );
    }
    renderStack([
      [1, entry("fill")],
      [2, entry("classes", () => <Classes />)],
    ]);
    await userEvent.click(screen.getByText("open fill"));
    await userEvent.click(screen.getByText("open classes"));
    await userEvent.click(screen.getByText("open color"));
    expect(screen.getByText("color content")).toBeDefined();
    act(() => void fireEvent.keyDown(document, { key: "Escape" }));
    expect(screen.queryByText("color content")).toBeNull();
    expect(screen.getByText("classes content")).toBeDefined();
    act(() => void fireEvent.keyDown(document, { key: "Escape" }));
    expect(screen.queryByText("classes content")).toBeNull();
    expect(screen.getByText("fill content")).toBeDefined();
    act(() => void fireEvent.keyDown(document, { key: "Escape" }));
    expect(screen.queryByText("fill content")).toBeNull();
  });

  it("opening the same key toggles it closed", async () => {
    renderStack([[1, entry("fill")]]);
    await userEvent.click(screen.getByText("open fill"));
    expect(screen.getByText("fill content")).toBeDefined();
    await userEvent.click(screen.getByText("open fill"));
    expect(screen.queryByText("fill content")).toBeNull();
  });

  it("a dropdown closes on outside pointer-down", async () => {
    const onClose = vi.fn();
    const onClick = vi.fn();
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    renderPanel(
      <DropdownMenu
        anchorEl={anchor}
        title="Draw as"
        items={[
          { label: "Points", sub: "Each feature as its own symbol", selected: true, onClick },
          { label: "Heatmap", onClick },
        ]}
        onClose={onClose}
      />
    );
    expect(screen.getByText("Each feature as its own symbol")).toBeDefined();
    await userEvent.click(screen.getByText("Heatmap"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("a second click on the trigger closes the menu for good", async () => {
    function Toggle() {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null);
      return (
        <>
          <button onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>All features</button>
          <DropdownMenu anchorEl={anchor} items={[{ label: "cafe" }]} onClose={() => setAnchor(null)} />
        </>
      );
    }
    renderPanel(<Toggle />);
    await userEvent.click(screen.getByText("All features"));
    expect(screen.getByText("cafe")).toBeDefined();
    await userEvent.click(screen.getByText("All features"));
    expect(screen.queryByText("cafe")).toBeNull();
  });

  it("a popover opened low in the window is never taller than the room below its top", async () => {
    renderPanel(
      <div data-style-panel>
        <PopoverProvider>
          <Harness entries={[[1, { ...entry("fill"), anchorTop: window.innerHeight - 40 }]]} />
        </PopoverProvider>
      </div>
    );
    await userEvent.click(screen.getByText("open fill"));
    const box = (screen.getByText("fill content").closest("[data-popover-frame]") as HTMLElement)
      .parentElement as HTMLElement;
    expect(parseFloat(box.style.maxHeight)).toBe(window.innerHeight - parseFloat(box.style.top) - 12);
  });

  it("a popover opened low moves up as far as it needs to end inside the window", async () => {
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return this.style.position === "fixed" ? 500 : 0;
    });
    renderPanel(
      <div data-style-panel>
        <PopoverProvider>
          <Harness entries={[[1, { ...entry("fill"), anchorTop: window.innerHeight - 40 }]]} />
        </PopoverProvider>
      </div>
    );
    await userEvent.click(screen.getByText("open fill"));
    const box = (screen.getByText("fill content").closest("[data-popover-frame]") as HTMLElement)
      .parentElement as HTMLElement;
    expect(parseFloat(box.style.top)).toBe(window.innerHeight - 12 - 500);
    height.mockRestore();
  });

  it("Escape closes a dropdown inside a popover and leaves the popover open", async () => {
    function Dropdown() {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null);
      return (
        <>
          <button onClick={(e) => setAnchor(e.currentTarget)}>menu</button>
          <DropdownMenu anchorEl={anchor} items={[{ label: "Heatmap" }]} onClose={() => setAnchor(null)} />
        </>
      );
    }
    renderStack([[1, entry("fill", () => <Dropdown />)]]);
    await userEvent.click(screen.getByText("open fill"));
    await userEvent.click(screen.getByText("menu"));
    expect(screen.getByText("Heatmap")).toBeDefined();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("Heatmap")).toBeNull();
    expect(screen.getByText("menu")).toBeDefined();
    expect(document.activeElement).toBe(screen.getByText("menu"));
  });

  it("a long dropdown has a search box that narrows its items; a short one has none", async () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const many = Array.from({ length: 13 }, (_, i) => ({ label: `Class ${i + 1}` }));
    const { unmount } = renderPanel(<DropdownMenu anchorEl={anchor} items={many} onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole("textbox", { name: "search_placeholder_short" }), "Class 1");
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Class 1",
      "Class 10",
      "Class 11",
      "Class 12",
      "Class 13",
    ]);
    unmount();
    renderPanel(<DropdownMenu anchorEl={anchor} items={many.slice(0, 3)} onClose={vi.fn()} />);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a control inside a popover measures its top against the panel, not the window", () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-style-panel", "");
    const control = document.createElement("button");
    document.body.append(panel, control);
    const rect = (top: number) =>
      ({ top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top }) as DOMRect;
    panel.getBoundingClientRect = () => rect(100);
    control.getBoundingClientRect = () => rect(300);
    expect(anchorTopOf(control)).toBe(200);
    panel.remove();
    control.remove();
  });

  it("a row in a popover that opens the next level shows it as expanded", async () => {
    function Level1() {
      const popover = usePopover();
      return <NavRow label="Colors" value="By classes" onOpen={() => popover.open(2, entry("classes"))} />;
    }
    renderStack([[1, entry("fill", () => <Level1 />)]]);
    await userEvent.click(screen.getByText("open fill"));
    const row = screen.getByRole("button", { name: /By classes/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(row);
    expect(screen.getByRole("button", { name: /By classes/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("levels draw outside the boxes that hold the panel (no clipping), beside the panel at their row", async () => {
    renderPanel(
      <div style={{ overflow: "hidden" }} data-testid="clip">
        <div data-style-panel>
          <PopoverProvider>
            <Harness
              entries={[
                [1, entry("fill")],
                [2, entry("palette")],
              ]}
            />
          </PopoverProvider>
        </div>
      </div>
    );
    await userEvent.click(screen.getByText("open fill"));
    await userEvent.click(screen.getByText("open palette"));
    for (const text of ["fill content", "palette content"]) {
      const frame = screen.getByText(text).closest("[data-popover-frame]") as HTMLElement;
      expect(screen.getByTestId("clip").contains(frame)).toBe(false);
      expect((frame.parentElement as HTMLElement).style.position).toBe("fixed");
    }
  });
});

describe("opening from a level closes what was opened from it before", () => {
  /** A popover's content: a button per editor it opens at the next level and per picker it opens. */
  function Content({
    name,
    levels = [],
    pickers = [],
  }: {
    name: string;
    levels?: PopoverEntry[];
    pickers?: PopoverEntry[];
  }) {
    const popover = usePopover();
    const next = useNextLevel();
    return (
      <>
        <p>{name} content</p>
        {levels.map((e) => (
          <button key={e.key} onClick={() => popover.open(next, e)}>
            open {e.key} from {name}
          </button>
        ))}
        {pickers.map((e) => (
          <button
            key={e.key}
            onClick={(event) => popover.open("picker", { ...e, anchorEl: event.currentTarget })}>
            pick {e.key} from {name}
          </button>
        ))}
      </>
    );
  }

  // The label editor (level 1) opens Halo (level 2), which opens Width (level 3); each has a color picker. A picker's
  // own content opens another picker.
  const widthColor = entry("width-color");
  const swatches = entry("swatches");
  const haloColor = entry("halo-color", () => <Content name="halo-color" pickers={[swatches]} />);
  const labelColor = entry("label-color");
  const width = entry("width", () => <Content name="width" pickers={[widthColor]} />);
  const halo = entry("halo", () => <Content name="halo" levels={[width]} pickers={[haloColor]} />);
  const label = entry("label", () => <Content name="label" levels={[halo]} pickers={[labelColor]} />);
  const ALL = [
    "label",
    "halo",
    "width",
    "label-color",
    "halo-color",
    "width-color",
    "panel-color",
    "swatches",
  ];
  /** The popovers open now, by key. */
  const openNow = () => ALL.filter((key) => screen.queryByText(`${key} content`) !== null);

  const renderLabel = () =>
    renderPanel(
      <div data-style-panel>
        <PopoverProvider>
          <Content name="panel" levels={[label]} pickers={[entry("panel-color")]} />
        </PopoverProvider>
      </div>
    );
  const click = (text: string) => userEvent.click(screen.getByText(text));

  it("a picker from level 1 closes level 2 (the label's color while Halo is open)", async () => {
    renderLabel();
    await click("open label from panel");
    await click("open halo from label");
    expect(openNow()).toEqual(["label", "halo"]);
    await click("pick label-color from label");
    expect(openNow()).toEqual(["label", "label-color"]);
  });

  it("a level 2 opened while a picker from level 1 is open closes the picker", async () => {
    renderLabel();
    await click("open label from panel");
    await click("pick label-color from label");
    await click("open halo from label");
    expect(openNow()).toEqual(["label", "halo"]);
  });

  it("a picker from level 2 keeps level 2 and level 1 open; closing it leaves them", async () => {
    renderLabel();
    await click("open label from panel");
    await click("open halo from label");
    await click("pick halo-color from halo");
    expect(openNow()).toEqual(["label", "halo", "halo-color"]);
    act(() => void fireEvent.keyDown(document, { key: "Escape" }));
    expect(openNow()).toEqual(["label", "halo"]);
  });

  it("with level 3 open, a picker from level 1 closes levels 2 and 3", async () => {
    renderLabel();
    await click("open label from panel");
    await click("open halo from label");
    await click("open width from halo");
    await click("pick width-color from width");
    expect(openNow()).toEqual(["label", "halo", "width", "width-color"]);
    await click("pick label-color from label");
    expect(openNow()).toEqual(["label", "label-color"]);
  });

  it("a picker from level 2 closes level 3", async () => {
    renderLabel();
    await click("open label from panel");
    await click("open halo from label");
    await click("open width from halo");
    await click("pick halo-color from halo");
    expect(openNow()).toEqual(["label", "halo", "halo-color"]);
  });

  it("a picker from the panel closes the levels", async () => {
    renderLabel();
    await click("open label from panel");
    await click("open halo from label");
    await click("pick panel-color from panel");
    expect(openNow()).toEqual(["panel-color"]);
  });

  it("the same picker again closes it and leaves its level open", async () => {
    renderLabel();
    await click("open label from panel");
    await click("pick label-color from label");
    await click("pick label-color from label");
    expect(openNow()).toEqual(["label"]);
  });

  it("a picker opened from a picker takes its place and keeps the levels", async () => {
    renderLabel();
    await click("open label from panel");
    await click("open halo from label");
    await click("pick halo-color from halo");
    await click("pick swatches from halo-color");
    expect(openNow()).toEqual(["label", "halo", "swatches"]);
  });
});

describe("dropdowns", () => {
  it("marks the chosen item with a check, not a fill", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    renderPanel(
      <DropdownMenu
        anchorEl={anchor}
        items={[{ label: "Points", selected: true }, { label: "Heatmap" }]}
        onClose={vi.fn()}
      />
    );
    const [points, heatmap] = screen.getAllByRole("menuitem");
    expect(points.querySelector("svg")).not.toBeNull();
    expect(heatmap.querySelector("svg")).toBeNull();
  });

  const classes = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Class ${i + 1}` }));
  const anchored = () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    return anchor;
  };

  it("a list of choices has a search box from 13 items on; 12 have none", () => {
    const { unmount } = renderPanel(
      <DropdownMenu anchorEl={anchored()} items={classes(13)} onClose={vi.fn()} />
    );
    expect(screen.getByRole("textbox", { name: "search_placeholder_short" })).toBeDefined();
    unmount();
    renderPanel(<DropdownMenu anchorEl={anchored()} items={classes(12)} onClose={vi.fn()} />);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("the search narrows its items", async () => {
    renderPanel(<DropdownMenu anchorEl={anchored()} items={classes(13)} onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole("textbox", { name: "search_placeholder_short" }), "Class 1");
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Class 1",
      "Class 10",
      "Class 11",
      "Class 12",
      "Class 13",
    ]);
  });

  it("from the search, Down moves into the items and Enter takes the first match", async () => {
    const picked = vi.fn();
    const items = classes(13).map((item) => ({ ...item, onClick: () => picked(item.label) }));
    const onClose = vi.fn();
    renderPanel(<DropdownMenu anchorEl={anchored()} items={items} onClose={onClose} />);
    const search = screen.getByRole("textbox", { name: "search_placeholder_short" });
    expect(document.activeElement).toBe(search);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[1]);
    // Typing on an item goes on in the search.
    await userEvent.keyboard("11");
    expect(document.activeElement).toBe(search);
    expect((search as HTMLInputElement).value).toBe("11");
    await userEvent.keyboard("{Enter}");
    expect(picked).toHaveBeenCalledWith("Class 11");
    expect(onClose).toHaveBeenCalled();
  });
});
