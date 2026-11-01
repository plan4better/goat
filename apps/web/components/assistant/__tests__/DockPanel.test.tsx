import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MIN_WIDTH,
  clampDockWidth,
  dockMaxWidth,
  resetDockWidthStore,
} from "@/lib/assistant/dockWidth";

import DockPanel from "@/components/assistant/DockPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const STORAGE_KEY = "goat:assistant-dock-width";

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

function renderPanel() {
  render(
    <DockPanel label="assistant_ask_ai" onDragOver={vi.fn()} onDrop={vi.fn()}>
      <p>conversation</p>
    </DockPanel>
  );
  return {
    handle: screen.getByRole("separator"),
    panelWidth: () => getComputedStyle(document.querySelector("[data-assistant-dock]") as Element).width,
  };
}

const valueOf = (handle: HTMLElement) => Number(handle.getAttribute("aria-valuenow"));

beforeEach(() => {
  window.localStorage.clear();
  resetDockWidthStore();
  setViewport(1440);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clampDockWidth", () => {
  it("keeps the width between 360 px and half the window", () => {
    expect(clampDockWidth(200, 1440)).toBe(DOCK_MIN_WIDTH);
    expect(clampDockWidth(500, 1440)).toBe(500);
    expect(clampDockWidth(900, 1440)).toBe(720);
    expect(dockMaxWidth(1440)).toBe(720);
  });

  it("never lets the maximum fall under the minimum in a narrow window", () => {
    expect(dockMaxWidth(600)).toBe(DOCK_MIN_WIDTH);
    expect(clampDockWidth(500, 600)).toBe(DOCK_MIN_WIDTH);
  });
});

describe("DockPanel", () => {
  it("starts at the default width with a labelled vertical separator", () => {
    const { handle, panelWidth } = renderPanel();

    expect(panelWidth()).toBe(`${DOCK_DEFAULT_WIDTH}px`);
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("assistant_resize");
    expect(handle.getAttribute("aria-valuemin")).toBe(String(DOCK_MIN_WIDTH));
    expect(handle.getAttribute("aria-valuemax")).toBe("720");
    expect(valueOf(handle)).toBe(DOCK_DEFAULT_WIDTH);
    expect(handle.tabIndex).toBe(0);
    expect(screen.getByText("conversation")).toBeTruthy();
  });

  it("changes the width in 24 px steps with the arrow keys, Home and End jump to the limits", () => {
    const { handle, panelWidth } = renderPanel();

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(valueOf(handle)).toBe(424);
    expect(panelWidth()).toBe("424px");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(valueOf(handle)).toBe(376);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    // Clamped at the minimum, not 352.
    expect(valueOf(handle)).toBe(DOCK_MIN_WIDTH);
    fireEvent.keyDown(handle, { key: "End" });
    expect(valueOf(handle)).toBe(720);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(valueOf(handle)).toBe(720);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(valueOf(handle)).toBe(DOCK_MIN_WIDTH);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(DOCK_MIN_WIDTH));
  });

  it("leaves other keys alone", () => {
    const { handle } = renderPanel();
    const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });

    handle.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(valueOf(handle)).toBe(DOCK_DEFAULT_WIDTH);
  });

  it("goes back to the default width on a double click and forgets the stored one", () => {
    window.localStorage.setItem(STORAGE_KEY, "600");
    const { handle } = renderPanel();
    expect(valueOf(handle)).toBe(600);

    fireEvent.doubleClick(handle);

    expect(valueOf(handle)).toBe(DOCK_DEFAULT_WIDTH);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("remembers the width across mounts", () => {
    const first = renderPanel();
    fireEvent.keyDown(first.handle, { key: "ArrowLeft" });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("424");

    document.body.innerHTML = "";
    resetDockWidthStore();
    const { handle } = renderPanel();

    expect(valueOf(handle)).toBe(424);
  });

  it("works without localStorage: the default width, and changes that last until a reload", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const { handle, panelWidth } = renderPanel();
    expect(panelWidth()).toBe(`${DOCK_DEFAULT_WIDTH}px`);

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(valueOf(handle)).toBe(424);
    fireEvent.doubleClick(handle);
    expect(valueOf(handle)).toBe(DOCK_DEFAULT_WIDTH);
  });

  it("ignores a stored value that is not a width", () => {
    window.localStorage.setItem(STORAGE_KEY, "wide");
    const { handle } = renderPanel();

    expect(valueOf(handle)).toBe(DOCK_DEFAULT_WIDTH);
  });

  it("clamps again when the window narrows, and returns to the chosen width when it widens", () => {
    window.localStorage.setItem(STORAGE_KEY, "700");
    const { handle } = renderPanel();
    expect(valueOf(handle)).toBe(700);

    act(() => {
      setViewport(1000);
      window.dispatchEvent(new Event("resize"));
    });
    expect(valueOf(handle)).toBe(500);
    expect(handle.getAttribute("aria-valuemax")).toBe("500");
    // The narrower window does not overwrite the choice.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("700");

    act(() => {
      setViewport(1440);
      window.dispatchEvent(new Event("resize"));
    });
    expect(valueOf(handle)).toBe(700);
  });

  it("follows a drag once per animation frame and stores the width when it ends", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const { handle } = renderPanel();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 1040 });
    expect(document.body.style.userSelect).toBe("none");
    // The overlay keeps the map and frames from taking the pointer.
    expect(handle.getAttribute("data-dragging")).toBe("true");
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1000 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 940 });
    // Two moves, one frame.
    expect(frames).toHaveLength(1);
    expect(valueOf(handle)).toBe(DOCK_DEFAULT_WIDTH);
    act(() => frames[0](0));
    expect(valueOf(handle)).toBe(500);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100 });

    // Clamped to half the window, applied at once on release and stored.
    expect(valueOf(handle)).toBe(720);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("720");
    expect(document.body.style.userSelect).toBe("");
    expect(handle.hasAttribute("data-dragging")).toBe(false);
  });

  it("stores nothing for a press without a move", () => {
    window.localStorage.setItem(STORAGE_KEY, "900");
    const { handle } = renderPanel();
    // 900 does not fit: shown at the maximum, kept as the choice.
    expect(valueOf(handle)).toBe(720);

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 720 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 720 });

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("900");
  });
});

describe("DockPanel entrance", () => {
  const renderWith = (entrance?: boolean) =>
    render(
      <DockPanel label="assistant_ask_ai" entrance={entrance} onDragOver={vi.fn()} onDrop={vi.fn()}>
        <p>conversation</p>
      </DockPanel>
    );
  const content = () => screen.getByText("conversation").parentElement as HTMLElement;
  const panel = () => document.querySelector("[data-assistant-dock]") as HTMLElement;
  /** The style rules emitted for the page, as text. */
  const styles = () => [...document.querySelectorAll("style")].map((style) => style.textContent).join("\n");

  it("brings its content in from the right as it opens, the panel at its full width at once", () => {
    renderWith(true);
    const { animation } = getComputedStyle(content());
    expect(animation).toMatch(/180ms ease-out/);
    const name = animation.split(" ")[0];
    // Opacity and a short slide: never the width, so the map beside it resizes once.
    const frames = styles().match(new RegExp(`@keyframes ${name}\\s*{[^}]*}[^}]*}`))?.[0] ?? "";
    expect(frames).toMatch(/opacity:\s*0/);
    expect(frames).toMatch(/translateX\(12px\)/);
    expect(frames).not.toMatch(/width/);
    expect(getComputedStyle(panel()).animation).toBe("");
    expect(getComputedStyle(panel()).transition).toBe("");
    expect(getComputedStyle(panel()).width).toBe(`${DOCK_DEFAULT_WIDTH}px`);
  });

  it("leaves the motion out where the system asks for reduced motion", () => {
    renderWith(true);
    const className = [...content().classList].find((name) => name.startsWith("css-"));
    expect(styles()).toMatch(
      new RegExp(
        `@media \\(prefers-reduced-motion: reduce\\)\\s*{\\s*\\.${className}\\s*{[^}]*[;{]animation:\\s*none`
      )
    );
  });

  it("shows its content at once without the entrance (the dock replacing its loading frame)", () => {
    renderWith(false);
    expect(getComputedStyle(content()).animation).toBe("");
  });
});
