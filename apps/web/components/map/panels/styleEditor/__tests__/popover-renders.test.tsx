// Opening or closing a popover renders the popovers that change and the rows whose opener or open state flips; the
// other rows and the editors under a picker stay as they are.
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memo, useState } from "react";
import { describe, expect, it } from "vitest";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import {
  type PopoverLevel,
  anchorTopOf,
  useIsOpen,
  useIsOpener,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";

import { renderPanel } from "./renderPanel";

const renders: Record<string, number> = {};
const count = (name: string) => (renders[name] = (renders[name] ?? 0) + 1);
const reset = () => Object.keys(renders).forEach((name) => delete renders[name]);

/** A row as the panel draws one: its button opens `level` and shows as expanded while that popover is open. */
const OpenerRow = memo(function OpenerRow({ name, level = 1 }: { name: string; level?: PopoverLevel }) {
  count(name);
  const popover = usePopover();
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const expanded = useIsOpener(button);
  return (
    <button
      ref={setButton}
      aria-expanded={expanded}
      onClick={(event) =>
        popover.open(level, {
          key: name,
          title: `${name} title`,
          anchorTop: anchorTopOf(event.currentTarget),
          render: () => <Editor name={name} />,
        })
      }>
      open {name}
    </button>
  );
});

/** A row that is active while the popover with its key is open, whichever control opened it. */
const KeyRow = memo(function KeyRow({ name }: { name: string }) {
  count(`key:${name}`);
  const open = useIsOpen(name);
  return <span data-testid={`key:${name}`} data-open={open} />;
});

/** A level 1 editor with a field that opens a picker. */
function Editor({ name }: { name: string }) {
  count(`editor:${name}`);
  return (
    <>
      <p>{name} content</p>
      <OpenerRow name={`${name}-picker`} level="picker" />
    </>
  );
}

function rows(scope?: unknown) {
  return (
    <div data-style-panel>
      <PopoverProvider scope={scope}>
        <OpenerRow name="fill" />
        <OpenerRow name="outline" />
        <KeyRow name="fill" />
        <KeyRow name="outline" />
      </PopoverProvider>
    </div>
  );
}

const button = (name: string) => screen.getByRole("button", { name: `open ${name}` });

describe("popover renders", () => {
  it("opening and closing an editor renders its row, not the other rows", async () => {
    renderPanel(rows());
    reset();
    await userEvent.click(button("fill"));
    expect(screen.getByText("fill content")).toBeDefined();
    expect(button("fill").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("key:fill").dataset.open).toBe("true");
    expect(renders.fill).toBeGreaterThan(0);
    expect(renders["key:fill"]).toBeGreaterThan(0);
    expect(renders.outline).toBeUndefined();
    expect(renders["key:outline"]).toBeUndefined();

    reset();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.close" }));
    expect(screen.queryByText("fill content")).toBeNull();
    expect(button("fill").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("key:fill").dataset.open).toBe("false");
    expect(renders.outline).toBeUndefined();
    expect(renders["key:outline"]).toBeUndefined();
  });

  it("switching editors renders the two rows whose state flips", async () => {
    renderPanel(rows());
    await userEvent.click(button("fill"));
    reset();
    await userEvent.click(button("outline"));
    expect(button("outline").getAttribute("aria-expanded")).toBe("true");
    expect(button("fill").getAttribute("aria-expanded")).toBe("false");
    expect(renders.fill).toBeGreaterThan(0);
    expect(renders.outline).toBeGreaterThan(0);
    expect(renders["key:fill"]).toBeGreaterThan(0);
    expect(renders["key:outline"]).toBeGreaterThan(0);
  });

  it("a picker opened from an editor leaves the editor and the panel's rows as they are", async () => {
    renderPanel(rows());
    await userEvent.click(button("fill"));
    reset();
    await userEvent.click(button("fill-picker"));
    expect(screen.getByText("fill-picker content")).toBeDefined();
    expect(button("fill-picker").getAttribute("aria-expanded")).toBe("true");
    expect(renders["editor:fill"]).toBeUndefined();
    expect(renders.fill).toBeUndefined();
    expect(renders.outline).toBeUndefined();
    expect(renders["key:fill"]).toBeUndefined();

    reset();
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(screen.queryByText("fill-picker content")).toBeNull();
    expect(button("fill-picker").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("fill content")).toBeDefined();
    expect(renders["editor:fill"]).toBeUndefined();
    expect(renders.fill).toBeUndefined();
    expect(renders.outline).toBeUndefined();
  });

  it("a new scope closes the popovers and clears the outlines", async () => {
    const { rerender } = renderPanel(rows("a"));
    await userEvent.click(button("fill"));
    expect(button("fill").getAttribute("aria-expanded")).toBe("true");
    // The panel's providers stay; only the scope changes.
    rerender(rows("b"));
    expect(screen.queryByText("fill content")).toBeNull();
    expect(button("fill").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("key:fill").dataset.open).toBe("false");
  });
});
