import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetAssistantStore } from "@/lib/assistant/store";

import DockSkeleton from "@/components/assistant/DockSkeleton";
import { resetDockLoader } from "@/components/assistant/dockLoader";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

/** The placeholders in document order. */
const skeletons = () => [...document.querySelectorAll<HTMLElement>(".MuiSkeleton-root")];
const size = (element: HTMLElement) => [element.style.width, element.style.height];

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  resetDockLoader();
});

describe("DockSkeleton", () => {
  it("draws the docked header as the dock has it: the 28 px mark, the title and the Beta chip", () => {
    render(<DockSkeleton variant="docked" />);
    const [mark, title, beta] = skeletons();
    expect(size(mark)).toEqual(["28px", "28px"]);
    expect(mark.className).toContain("MuiSkeleton-rounded");
    expect(title.className).toContain("MuiSkeleton-text");
    expect(beta.className).toContain("MuiSkeleton-rounded");
    expect(beta.style.height).toBe("19px");
  });

  it("brings its content in as the docked dock opens", () => {
    render(<DockSkeleton variant="docked" />);
    const content = screen.getByRole("separator", { name: "assistant_resize" })
      .nextElementSibling as HTMLElement;
    expect(getComputedStyle(content).animation).toMatch(/180ms ease-out/);
  });

  it("centres the start page in the free space, mark, heading, sub and four starters", () => {
    render(<DockSkeleton variant="docked" />);
    const all = skeletons();
    const avatar = all.find((element) => element.style.width === "44px") as HTMLElement;
    expect(size(avatar)).toEqual(["44px", "44px"]);
    // Centred by its auto margins in a flex column, as the start page is.
    let block: HTMLElement | null = avatar;
    while (block && getComputedStyle(block).marginTop !== "auto") block = block.parentElement;
    expect(block).not.toBeNull();
    expect(getComputedStyle(block?.parentElement as HTMLElement).flexDirection).toBe("column");
    const starters = all.filter((element) => element.style.height === "50px");
    expect(starters).toHaveLength(4);
  });

  it("puts the note line above the composer box, and the box last", () => {
    render(<DockSkeleton variant="docked" />);
    const all = skeletons();
    const box = all[all.length - 1];
    expect(box.style.height).toBe("80px");
    // One 12 px line with the Feedback link at its end, right above the box.
    const [note, feedback] = all.slice(-3, -1);
    for (const line of [note, feedback]) expect(getComputedStyle(line).fontSize).toBe("12px");
    expect(note.parentElement).toBe(feedback.parentElement);
    expect(note.parentElement?.nextElementSibling).toBe(box);
  });

  it("draws the full-screen sidebar header with the mark and the Beta chip", () => {
    // Without matchMedia the window counts as wider than a phone: full screen has its sidebar.
    render(<DockSkeleton variant="fullscreen" />);
    const [mark, name, beta] = skeletons();
    expect(size(mark)).toEqual(["28px", "28px"]);
    expect(name.className).toContain("MuiSkeleton-text");
    expect(beta.style.height).toBe("19px");
    const all = skeletons();
    expect(all.find((element) => element.style.width === "52px")).toBeTruthy();
    expect(all[all.length - 1].style.height).toBe("96px");
  });
});
