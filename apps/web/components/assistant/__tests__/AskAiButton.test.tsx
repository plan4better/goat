import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAssistantStore, setDockState } from "@/lib/assistant/store";

import AskAiButton, { INTRO_KEY, RING_TURN_MS, resetAskAiIntro } from "@/components/assistant/AskAiButton";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/components/assistant/dockLoader", () => ({ prefetchAssistant: vi.fn() }));

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** A browser whose user asks for reduced motion, or not. */
function motion(reduced: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: reduced && query === REDUCED_MOTION,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
}

const { matchMedia } = window;
const button = () => screen.getByRole("button", { name: "assistant_ask_ai" });
const ring = () => button().querySelector<HTMLElement>("[data-ask-ai-ring]");
/** The style rules emitted for the page, as text. */
const styles = () => [...document.querySelectorAll("style")].map((style) => style.textContent).join("\n");

beforeEach(() => {
  window.sessionStorage.clear();
  resetAskAiIntro();
  resetAssistantStore();
  setDockState({ enabled: true });
  motion(false);
});
afterEach(() => {
  window.matchMedia = matchMedia;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Ask AI ring", () => {
  it("turns three times when the button first shows in a session, then fades and rests", () => {
    vi.useFakeTimers();
    render(<AskAiButton />);
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("intro");
    // Set as the intro starts.
    expect(window.sessionStorage.getItem(INTRO_KEY)).not.toBeNull();
    expect(RING_TURN_MS).toBe(2400);
    expect(styles()).toMatch(/2400ms linear 3/);
    act(() => vi.advanceTimersByTime(3 * RING_TURN_MS - 1));
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("intro");
    act(() => vi.advanceTimersByTime(1));
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("rest");
  });

  it("plays the intro once per session: not on the next mount, nor after a reload", () => {
    const first = render(<AskAiButton compact />);
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("intro");
    first.unmount();
    const second = render(<AskAiButton compact />);
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("rest");
    second.unmount();
    // A new page in the same session: the session's flag holds it back.
    resetAskAiIntro();
    render(<AskAiButton compact />);
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("rest");
  });

  it("shows the ring turning while the pointer is on the button or it has keyboard focus", () => {
    render(<AskAiButton />);
    // Pointing at it ends the intro: the ring stays and keeps turning.
    fireEvent.pointerEnter(button());
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("rest");
    expect(styles()).toMatch(/:hover \[data-ask-ai-ring\][^{]*{[^}]*opacity:\s*1/);
    expect(styles()).toMatch(/:focus-visible \[data-ask-ai-ring\]/);
    expect(styles()).toMatch(/2400ms linear infinite/);
  });

  it("has no ring and no motion while the dock is open, and plays no intro then", () => {
    setDockState({ open: true });
    render(<AskAiButton />);
    expect(ring()).toBeNull();
    expect(window.sessionStorage.getItem(INTRO_KEY)).toBeNull();
    act(() => setDockState({ open: false }));
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("rest");
  });

  it("ends the intro when the dock opens during it", () => {
    render(<AskAiButton />);
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("intro");
    act(() => setDockState({ open: true }));
    expect(ring()).toBeNull();
    act(() => setDockState({ open: false }));
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("rest");
  });

  it("moves nothing with reduced motion: no intro, and the ring shows still on hover", () => {
    motion(true);
    render(<AskAiButton />);
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("rest");
    expect(window.sessionStorage.getItem(INTRO_KEY)).toBeNull();
    // Every animation sits behind the no-preference query; the hover opacity does not.
    const css = styles();
    const guarded: string[] =
      css.match(/@media \(prefers-reduced-motion: no-preference\)\s*{(?:[^{}]*{[^{}]*})*\s*}/g) ?? [];
    const outside = guarded.reduce<string>((rest, block) => rest.replace(block, ""), css);
    expect(guarded.join("")).toMatch(/2400ms linear/);
    expect(outside).not.toMatch(/2400ms linear/);
    expect(outside).toMatch(/:hover \[data-ask-ai-ring\][^{]*{[^}]*opacity:\s*1/);
  });

  it("works without session storage: the intro plays once per page load", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const first = render(<AskAiButton />);
    expect(button()).toBeTruthy();
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("intro");
    first.unmount();
    render(<AskAiButton />);
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("rest");
  });

  it("plays the intro under StrictMode, whose second effect run keeps the first run's claim", () => {
    vi.useFakeTimers();
    const first = render(
      <StrictMode>
        <AskAiButton />
      </StrictMode>
    );
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("intro");
    act(() => vi.advanceTimersByTime(3 * RING_TURN_MS));
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("rest");
    first.unmount();
    // Another button on the next page of the same session: no second intro.
    resetAskAiIntro();
    render(
      <StrictMode>
        <AskAiButton />
      </StrictMode>
    );
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("rest");
  });

  it("does not replay a finished intro when the dock is switched off and on again", () => {
    vi.useFakeTimers();
    render(
      <StrictMode>
        <AskAiButton />
      </StrictMode>
    );
    act(() => vi.advanceTimersByTime(3 * RING_TURN_MS));
    act(() => setDockState({ enabled: false }));
    act(() => setDockState({ enabled: true }));
    expect(ring()?.getAttribute("data-ask-ai-ring")).toBe("rest");
  });

  it("keeps the same ring when it turns compact and back, so the intro runs on", () => {
    const view = render(<AskAiButton />);
    const drawn = ring();
    expect(drawn?.getAttribute("data-ask-ai-ring")).toBe("intro");
    for (const compact of [true, false]) {
      view.rerender(<AskAiButton compact={compact} />);
      // A new node would start its animation again.
      expect(ring(), String(compact)).toBe(drawn);
      expect(drawn?.getAttribute("data-ask-ai-ring")).toBe("intro");
    }
  });

  it("keeps the same focused button when it turns compact and back", () => {
    const view = render(<AskAiButton />);
    const node = button();
    act(() => node.focus());
    for (const compact of [true, false]) {
      view.rerender(<AskAiButton compact={compact} />);
      expect(button(), String(compact)).toBe(node);
      expect(document.activeElement, String(compact)).toBe(node);
    }
  });

  it("keeps the button's size: the ring is drawn over its border, out of the layout", () => {
    render(<AskAiButton compact />);
    const drawn = ring() as HTMLElement;
    expect(drawn.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(drawn).position).toBe("absolute");
    expect(getComputedStyle(drawn).pointerEvents).toBe("none");
    // Compact: the 32px circle with the icon alone, named by its label.
    expect(button().textContent).toBe("");
    expect(button().getAttribute("aria-label")).toBe("assistant_ask_ai");
    expect(getComputedStyle(button()).width).toBe("32px");
    expect(getComputedStyle(button()).height).toBe("32px");
  });
});
