import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { DropdownMenu } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import {
  type PopoverEntry,
  type PopoverLevel,
  anchorTopOf,
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

  it("Escape closes picker, then level 2, then level 1", async () => {
    renderStack([
      [1, entry("fill")],
      [2, entry("classes")],
      ["picker", entry("color")],
    ]);
    await userEvent.click(screen.getByText("open fill"));
    await userEvent.click(screen.getByText("open classes"));
    await userEvent.click(screen.getByText("open color"));
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
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `Class ${i + 1}` }));
    const { unmount } = renderPanel(<DropdownMenu anchorEl={anchor} items={many} onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole("textbox", { name: "search_placeholder_short" }), "Class 1");
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Class 1",
      "Class 10",
      "Class 11",
      "Class 12",
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
