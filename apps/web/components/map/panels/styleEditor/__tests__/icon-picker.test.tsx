import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, createElement, memo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMOJI, EMOJI_GROUPS } from "@/lib/style/generated/emoji";

import { IconPicker } from "@/components/map/panels/styleEditor/pickers/IconPicker";
import { loadEmoji } from "@/components/map/panels/styleEditor/pickers/iconRefs";

import { renderWithProviders } from "./renderPanel";

// Every tile drawn counts: a tile whose props did not change is not drawn again (IconTile is memoised).
const tiles = vi.hoisted(() => ({ renders: 0 }));
vi.mock("@/components/map/panels/styleEditor/pickers/iconTiles", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/map/panels/styleEditor/pickers/iconTiles")>();
  return {
    ...actual,
    IconTile: memo(function CountedTile(props: ComponentProps<typeof actual.IconTile>) {
      tiles.renders += 1;
      return createElement(actual.IconTile, props);
    }),
  };
});

const GROUP = "style_editor.emoji_group_";

async function openEmoji(value = "emoji:1f600") {
  renderWithProviders(<IconPicker value={value} onChange={() => undefined} />);
  await screen.findByText(`${GROUP}food_drink`);
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ icons: {} }))
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("icon picker", () => {
  it("lists the marker shapes and pins after the other symbol groups", async () => {
    renderWithProviders(<IconPicker value="goat:park" onChange={() => undefined} />);
    const headings = (await screen.findAllByText(/^icon_category_/)).map((h) => h.textContent);
    expect(headings[0]).toBe("icon_category_urban_infrastructure");
    expect(headings.at(-1)).toBe("icon_category_shapes_pins");
  });

  it("the group in view shows its heading above the list, the first group without one in the list", async () => {
    renderWithProviders(<IconPicker value="goat:park" onChange={() => undefined} />);
    // Above the list only: the list starts with the group's tiles.
    const [urban] = await screen.findAllByText("icon_category_urban_infrastructure");
    expect(screen.getAllByText("icon_category_urban_infrastructure")).toHaveLength(1);
    const [cultural] = screen.getAllByText("icon_category_cultural_landmark");
    expect(screen.getAllByText("icon_category_cultural_landmark")).toHaveLength(1);
    // The list holds the groups; the heading in view is outside it, so no tile ever scrolls under it.
    const list = cultural.parentElement?.parentElement as HTMLElement;
    expect(list.contains(urban)).toBe(false);

    await userEvent.click(screen.getByRole("tab", { name: "style_editor.icon_tab_emoji" }));
    expect(await screen.findAllByText(`${GROUP}smileys_emotion`)).toHaveLength(1);
    expect(screen.getAllByText(`${GROUP}food_drink`)).toHaveLength(1);
  });

  it("a group in the bar scrolls its tiles to the top of the list under its heading; scrolling updates both", async () => {
    await openEmoji();
    const food = screen.getByText(`${GROUP}food_drink`).parentElement as HTMLElement;
    const sections = [...(food.parentElement as HTMLElement).children] as HTMLElement[];
    // The list sits 185 px below the picker's top; each group 150 px tall, its tiles 30 px below its heading (the
    // first group has none in the list).
    const listOffset = 185;
    const tilesTop = (i: number) => i * 150 + (i ? 30 : 0);
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      const index = sections.indexOf(this);
      if (index >= 0) return index * 150;
      const tiles = sections.findIndex((s) => s.lastElementChild === this);
      if (tiles >= 0) return tilesTop(tiles);
      return sections.some((s) => this.contains(s)) ? listOffset : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return sections.includes(this) ? 150 : 0;
    });
    const scrollTo = vi.fn(function (this: HTMLElement, { top }: { top: number }) {
      Object.defineProperty(this, "scrollTop", { value: top, configurable: true });
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: scrollTo, configurable: true });

    const foodIndex = sections.indexOf(food);
    fireEvent.click(screen.getByRole("button", { name: `${GROUP}food_drink` }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: tilesTop(foodIndex) });
    const list = scrollTo.mock.contexts.at(-1) as HTMLElement;
    expect(list.contains(food)).toBe(true);
    // Its heading shows above the list, and in the list (scrolled out of view).
    expect(screen.getAllByText(`${GROUP}food_drink`)).toHaveLength(2);

    const scrollBy = (top: number) => {
      Object.defineProperty(list, "scrollTop", { value: top, configurable: true });
      fireEvent.scroll(list);
    };
    // Scrolled by hand to the travel group: the heading above the list and the bar follow.
    const travel = sections.findIndex((s) => s.textContent?.startsWith(`${GROUP}travel_places`));
    scrollBy(tilesTop(travel));
    expect(screen.getAllByText(`${GROUP}travel_places`)).toHaveLength(2);
    expect(screen.getByRole("button", { name: `${GROUP}travel_places` }).getAttribute("aria-current")).toBe(
      "true"
    );
    expect(
      screen.getByRole("button", { name: `${GROUP}food_drink` }).getAttribute("aria-current")
    ).toBeNull();
    // While the travel group's heading slides out of the list, the group before it still shows above.
    scrollBy(tilesTop(travel) - 10);
    expect(screen.getAllByText(`${GROUP}travel_places`)).toHaveLength(1);
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  });

  it("the tone row shows its hands from their own small images, not from the tone sheets", async () => {
    await openEmoji();
    await userEvent.click(screen.getByTitle("style_editor.emoji_tone"));
    const light = screen.getByTitle("style_editor.emoji_tone_1").querySelector("img");
    expect(light?.getAttribute("src")).toMatch(/\/icons\/emoji\/270b-1f3fb\.webp$/);
    expect(screen.getByTitle("style_editor.emoji_tone").querySelector("img")?.getAttribute("src")).toMatch(
      /\/icons\/emoji\/270b\.webp$/
    );
  });

  it("a skin tone draws again only the emoji that have tones", async () => {
    await openEmoji();
    await userEvent.click(screen.getByTitle("style_editor.emoji_tone"));
    tiles.renders = 0;
    await userEvent.click(screen.getByTitle("style_editor.emoji_tone_3"));
    const toned = EMOJI.filter((e) => e.tones).length;
    await waitFor(() => expect(tiles.renders).toBeGreaterThan(0));
    expect(tiles.renders).toBeLessThanOrEqual(toned);
    expect(screen.getByTitle("waving hand sign").innerHTML).toContain("tone-3");
  });
});

// A laid-out pane: the list 260 px tall, seven tiles a row, each heading 36 px. A grid's height is the one it states;
// a group is its heading and its grid, one under the other.
const HEAD = 36;
const LIST = 260;
const COLS = 7;
const ROW = 40;
const gridHeight = (count: number) => Math.ceil(count / COLS) * ROW - 4;

function mockLayout() {
  const isGrid = (el: Element) => el instanceof HTMLElement && el.style.height !== "";
  const height = (el: Element): number => {
    if (isGrid(el)) return parseFloat((el as HTMLElement).style.height);
    const grid = el.lastElementChild;
    return grid && isGrid(grid) ? (grid.previousElementSibling ? HEAD : 0) + height(grid) : 0;
  };
  const top = (el: Element): number => {
    if (isGrid(el)) return top(el.parentElement as Element) + (el.previousElementSibling ? HEAD : 0);
    let y = 0;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) y += height(s);
    return y;
  };
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return top(this);
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return height(this);
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-pane-list") ? LIST : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return isGrid(this) ? COLS * 36 : 0;
  });
  const scrollTo = vi.fn(function (this: HTMLElement, { top }: { top: number }) {
    Object.defineProperty(this, "scrollTop", { value: top, configurable: true });
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: scrollTo, configurable: true });
  return scrollTo;
}

/** Where a group's tiles start in the list: the groups before it, then its heading. */
function tilesTopOf(group: string) {
  let y = 0;
  for (const [i, g] of EMOJI_GROUPS.entries()) {
    if (i > 0) y += HEAD;
    if (g === group) return y;
    y += gridHeight(EMOJI.filter((e) => e.group === g).length);
  }
  throw new Error(group);
}

const indexIn = (code: string) => {
  const emoji = EMOJI.find((e) => e.code === code) as (typeof EMOJI)[number];
  return { emoji, index: EMOJI.filter((e) => e.group === emoji.group).indexOf(emoji) };
};

describe("icon picker on a laid-out list", () => {
  afterEach(() => {
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  });

  it("opens on the selected emoji's group with its tiles at the list's top, drawing only the rows near view", async () => {
    await loadEmoji();
    const scrollTo = mockLayout();
    const { emoji, index } = indexIn("1f353");
    // The strawberry's row fits under its group's start: the list shows the group as its button in the bar would.
    expect(Math.floor(index / COLS) * ROW + 36).toBeLessThanOrEqual(LIST);
    renderWithProviders(<IconPicker value="emoji:1f353" onChange={() => undefined} />);
    expect(scrollTo).toHaveBeenCalledWith({ top: tilesTopOf("food_drink") });
    const tile = screen.getByTitle(emoji.name);
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByText(`${GROUP}food_drink`)).toHaveLength(2);
    expect(screen.getByRole("button", { name: `${GROUP}food_drink` }).getAttribute("aria-current")).toBe(
      "true"
    );
    // Far from view: the first smiley and the flags are not drawn, and only a few rows of tiles are.
    expect(screen.queryByTitle("grinning face")).toBeNull();
    expect(screen.queryByTitle("chequered flag")).toBeNull();
    expect(document.querySelectorAll(".goat-icon-tile").length).toBeLessThan(200);
    // A group out of view keeps its height and no more.
    const smileys = document.querySelector<HTMLElement>("[data-pane-list] [style*='height']") as HTMLElement;
    expect(smileys.childElementCount).toBe(0);
    expect(smileys.style.height).toBe(
      `${gridHeight(EMOJI.filter((e) => e.group === "smileys_emotion").length)}px`
    );
    expect(smileys.style.paddingTop).toBe("0px");
  });

  it("an emoji deep in its group opens with its row in the middle of the list", async () => {
    await loadEmoji();
    const scrollTo = mockLayout();
    const last = EMOJI.filter((e) => e.group === "flags").at(-1) as (typeof EMOJI)[number];
    const { index } = indexIn(last.code);
    renderWithProviders(<IconPicker value={`emoji:${last.code}`} onChange={() => undefined} />);
    const row = tilesTopOf("flags") + Math.floor(index / COLS) * ROW;
    expect(scrollTo).toHaveBeenCalledWith({ top: row - (LIST - 36) / 2 });
    expect(screen.getByTitle(last.name).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTitle("chequered flag")).toBeNull();
  });

  it("scrolling and the bar draw the rows that come into view", async () => {
    await loadEmoji();
    mockLayout();
    renderWithProviders(<IconPicker value="emoji:1f355" onChange={() => undefined} />);
    expect(screen.queryByTitle("chequered flag")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `${GROUP}flags` }));
    expect(screen.getByTitle("chequered flag")).toBeTruthy();
    expect(screen.queryByTitle("slice of pizza")).toBeNull();

    const list = document.querySelector("[data-pane-list]") as HTMLElement;
    Object.defineProperty(list, "scrollTop", { value: tilesTopOf("food_drink"), configurable: true });
    fireEvent.scroll(list);
    expect(screen.getByTitle("slice of pizza")).toBeTruthy();
    expect(screen.queryByTitle("chequered flag")).toBeNull();
  });

  it("the group bar draws each group's emoji from its own small image, so it loads no sheet", async () => {
    await loadEmoji();
    mockLayout();
    renderWithProviders(<IconPicker value="emoji:1f355" onChange={() => undefined} />);
    const bar = screen.getByRole("button", { name: `${GROUP}flags` });
    expect(bar.querySelector("img")?.getAttribute("src")).toMatch(/\/icons\/emoji\/1f3c1\.webp$/);
    const sheets = new Set(
      [...document.querySelectorAll<HTMLElement>(".goat-icon-tile span")].map((s) => s.style.backgroundImage)
    );
    expect(
      [...sheets].every((url) => /sheets\/(food_drink|animals_nature|travel_places)\.webp/.test(url))
    ).toBe(true);
  });

  it("with the emoji loaded, the emoji tab draws its tiles at once, without a loading step", async () => {
    await loadEmoji();
    mockLayout();
    renderWithProviders(<IconPicker value="emoji:1f355" onChange={() => undefined} />);
    expect(screen.queryByText("loading")).toBeNull();
    expect(screen.getByTitle("slice of pizza")).toBeTruthy();
  });

  it("opens on the selected symbol's group", async () => {
    const scrollTo = mockLayout();
    renderWithProviders(<IconPicker value="goat:shape-pin" onChange={() => undefined} />);
    await screen.findAllByText("icon_category_shapes_pins");
    expect(scrollTo).toHaveBeenCalled();
    expect(screen.getAllByText("icon_category_shapes_pins")).toHaveLength(2);
  });
});
