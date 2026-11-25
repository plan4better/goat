import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it, vi } from "vitest";

import { ClassGrid, ClassGridRow } from "@/components/map/panels/styleEditor/editors/ClassGrid";

import { dragRow } from "./dragRows";
import { renderWithProviders } from "./renderPanel";

const move = <T,>(list: T[], from: number, to: number) => {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

/** A list of classes in a grid that reorders them, keyed by name (`keyed`) or by place, showing the first `shown`. */
function List({
  names,
  keyed = true,
  shown,
  onSwatch,
  onReorder,
}: {
  names: string[];
  keyed?: boolean;
  shown?: number;
  onSwatch(name: string): void;
  onReorder(from: number, to: number): void;
}) {
  const [list, setList] = useState(names);
  return (
    <ClassGrid
      head={{ value: "Color", label: "Value", count: "" }}
      styled={false}
      rows={list.length}
      onReorder={(from, to) => {
        onReorder(from, to);
        setList((now) => move(now, from, to));
      }}>
      {list.slice(0, shown ?? list.length).map((name, i) => (
        <ClassGridRow
          key={keyed ? name : i}
          index={i}
          swatch={<button type="button" aria-label={`swatch ${name}`} onClick={() => onSwatch(name)} />}
          label={<input aria-label={`name ${name}`} value={name} readOnly />}
          count={`${name} count`}
          onToggle={() => undefined}
        />
      ))}
      <ClassGridRow swatch={<span />} label={<input aria-label="name Other" value="Other" readOnly />} />
    </ClassGrid>
  );
}

function draw(options: { keyed?: boolean; shown?: number } = {}) {
  const onReorder = vi.fn();
  const onSwatch = vi.fn();
  renderWithProviders(
    <List names={["A", "B", "C", "D"]} onReorder={onReorder} onSwatch={onSwatch} {...options} />
  );
  return { onReorder, onSwatch };
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-class-row]"));
const order = () => rows().map((row) => (row.querySelector("input") as HTMLInputElement).value);

describe("the class grid's rows", () => {
  it("a row dragged by the pointer from its count or its swatch to another row's place moves there", async () => {
    const { onReorder, onSwatch } = draw();
    await dragRow(screen.getByText("A count"), rows()[2]);
    expect(onReorder).toHaveBeenLastCalledWith(0, 2);
    expect(order()).toEqual(["B", "C", "A", "D", "Other"]);
    // Let go over the swatch it was pressed on: the drag is no click, no picker opens.
    await dragRow(screen.getByRole("button", { name: "swatch D" }), rows()[0]);
    expect(onReorder).toHaveBeenLastCalledWith(3, 0);
    expect(order()).toEqual(["D", "B", "C", "A", "Other"]);
    expect(onSwatch).not.toHaveBeenCalled();
    // A click opens what it opens.
    await userEvent.click(screen.getByRole("button", { name: "swatch B" }));
    expect(onSwatch).toHaveBeenCalledWith("B");
  });

  it("a press in a row's text box selects its text: moved over other rows, it moves no row", async () => {
    const { onReorder } = draw();
    await dragRow(screen.getByRole("textbox", { name: "name A" }), rows()[2]);
    expect(onReorder).not.toHaveBeenCalled();
    expect(order()).toEqual(["A", "B", "C", "D", "Other"]);
    // Text the browser drags out of the box is no row's drag either.
    const box = screen.getByRole("textbox", { name: "name B" });
    fireEvent.dragStart(box);
    fireEvent.dragOver(rows()[3]);
    fireEvent.drop(rows()[3]);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("Other and No data stay in place; the rows add no stop for the keyboard and name their keys", () => {
    draw();
    expect(rows().map((row) => row.getAttribute("aria-keyshortcuts"))).toEqual([
      "Alt+ArrowUp Alt+ArrowDown",
      "Alt+ArrowUp Alt+ArrowDown",
      "Alt+ArrowUp Alt+ArrowDown",
      "Alt+ArrowUp Alt+ArrowDown",
      null,
    ]);
    for (const row of rows()) {
      expect(row.getAttribute("tabindex")).toBeNull();
      expect(row.getAttribute("role")).toBeNull();
    }
  });

  for (const keyed of [true, false]) {
    it(`Alt and an arrow move the row of the focused control one place, the focus with it (rows keyed by ${keyed ? "class" : "place"})`, async () => {
      const { onReorder } = draw({ keyed });
      screen.getByRole("textbox", { name: "name B" }).focus();
      await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
      expect(onReorder).toHaveBeenLastCalledWith(1, 2);
      expect(order()).toEqual(["A", "C", "B", "D", "Other"]);
      // The same control of the moved row: its name box.
      expect((document.activeElement as HTMLInputElement).value).toBe("B");
      expect(rows()[2].contains(document.activeElement)).toBe(true);
      // From its swatch, up twice.
      rows()[2].querySelector("button")?.focus();
      await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
      await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
      expect(order()).toEqual(["B", "A", "C", "D", "Other"]);
      expect(document.activeElement).toBe(rows()[0].querySelector("button"));
      // Not past the first row, nor onto Other.
      await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
      rows()[3].querySelector("button")?.focus();
      await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
      expect(order()).toEqual(["B", "A", "C", "D", "Other"]);
      // The arrows alone, or with another key, move nothing.
      await userEvent.keyboard("{ArrowUp}{Control>}{Alt>}{ArrowUp}{/Alt}{/Control}");
      expect(order()).toEqual(["B", "A", "C", "D", "Other"]);
      expect(onReorder).toHaveBeenCalledTimes(3);
    });
  }

  it("a text box left by Alt and an arrow hands what it holds to its own class, not the one moved into its place", async () => {
    const commits: string[][] = [];
    function Boxes() {
      const [list, setList] = useState(["A", "B"]);
      return (
        <ClassGrid
          head={{ value: "", label: "", count: "" }}
          rows={list.length}
          onReorder={(from, to) => setList((now) => move(now, from, to))}>
          {list.map((name, i) => (
            <ClassGridRow
              // Keyed by place: the box stays where it is, the class in it changes.
              key={i}
              index={i}
              swatch={<span />}
              label={
                <input
                  aria-label={`box ${i}`}
                  defaultValue=""
                  onBlur={(event) => commits.push([name, event.currentTarget.value])}
                />
              }
            />
          ))}
        </ClassGrid>
      );
    }
    renderWithProviders(<Boxes />);
    await userEvent.click(screen.getByRole("textbox", { name: "box 0" }));
    await userEvent.keyboard("7");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(commits[0]).toEqual(["A", "7"]);
  });

  it("a long list that shows some rows moves them among themselves only", async () => {
    const { onReorder } = draw({ shown: 2 });
    screen.getByRole("textbox", { name: "name B" }).focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("keys and presses in a menu a row's control opened are the menu's", async () => {
    const onReorder = vi.fn();
    const menu = document.createElement("div");
    document.body.appendChild(menu);
    renderWithProviders(
      <ClassGrid head={{ value: "", label: "", count: "" }} rows={2} onReorder={onReorder}>
        <ClassGridRow
          index={0}
          swatch={<span />}
          label={createPortal(<button type="button">In a menu</button>, menu)}
        />
        <ClassGridRow index={1} swatch={<span />} label={<span />} />
      </ClassGrid>
    );
    screen.getByRole("button", { name: "In a menu" }).focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await act(async () => {});
    expect(onReorder).not.toHaveBeenCalled();
    // A press in the menu moved over the list drags no row either.
    await dragRow(screen.getByRole("button", { name: "In a menu" }), rows()[1]);
    expect(onReorder).not.toHaveBeenCalled();
  });
});
