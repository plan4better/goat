import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DashboardSidebar from "@/components/dashboard/Sidebar";

const { pathname } = vi.hoisted(() => ({ pathname: { value: "/content" } }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }));

const setNavVisible = vi.fn();
const renderSidebar = (hidden = false, navVisible = false) =>
  render(
    <DashboardSidebar
      hidden={hidden}
      navVisible={navVisible}
      width={240}
      collapsedWidth={72}
      setNavVisible={setNavVisible}
    />
  );

beforeEach(() => {
  pathname.value = "/content";
  setNavVisible.mockReset();
});

describe("DashboardSidebar", () => {
  it("names every place on the rail, settings last", () => {
    renderSidebar();
    const rail = screen.getByRole("navigation", { name: "main_navigation" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
      "home",
      "content",
      "catalog",
      "settings",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/home",
      "/content",
      "/catalog",
      "/settings/profile",
    ]);
  });

  it("marks the current place", () => {
    pathname.value = "/settings/members";
    renderSidebar();
    const rail = screen.getByRole("navigation", { name: "main_navigation" });
    const current = within(rail)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.getAttribute("aria-label"))).toEqual(["settings"]);
  });

  it("shows a place's name next to its icon on hover", async () => {
    renderSidebar();
    const rail = screen.getByRole("navigation", { name: "main_navigation" });
    fireEvent.mouseOver(within(rail).getByRole("link", { name: "catalog" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("catalog");
  });

  it("never opens over the page when the pointer passes", () => {
    renderSidebar();
    const rail = screen.getByRole("navigation", { name: "main_navigation" });
    fireEvent.mouseEnter(rail);
    fireEvent.mouseOver(within(rail).getAllByRole("link")[0]);
    expect(setNavVisible).not.toHaveBeenCalled();
  });

  it("lists the places in the drawer on a phone, and closes it on a pick", () => {
    renderSidebar(true, true);
    const drawer = screen.getByRole("presentation");
    const links = within(drawer).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["home", "content", "catalog", "settings"]);
    fireEvent.click(links[2]);
    expect(setNavVisible).toHaveBeenCalledWith(false);
  });

  it("gives each place in the drawer one stop, and marks the current one", () => {
    pathname.value = "/settings/profile";
    renderSidebar(true, true);
    const drawer = screen.getByRole("presentation");
    // A link per place and nothing nested in it; the only button closes the drawer.
    expect(within(drawer).getAllByRole("link")).toHaveLength(4);
    expect(
      within(drawer)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual(["close"]);
    const current = within(drawer)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual(["settings"]);
  });

  it("marks the current place in the drawer as the rail does", () => {
    const rail = renderSidebar();
    const onRail = within(screen.getByRole("navigation", { name: "main_navigation" })).getByRole("link", {
      name: "content",
    });
    const { color, backgroundColor } = getComputedStyle(onRail);
    rail.unmount();
    renderSidebar(true, true);
    const inDrawer = within(screen.getByRole("presentation")).getByRole("link", { name: "content" });
    expect(getComputedStyle(inDrawer).color).toBe(color);
    expect(getComputedStyle(inDrawer).backgroundColor).toBe(backgroundColor);
    expect(backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("closes the drawer with its own button", () => {
    renderSidebar(true, true);
    fireEvent.click(within(screen.getByRole("presentation")).getByRole("button", { name: "close" }));
    expect(setNavVisible).toHaveBeenCalledWith(false);
  });

  it("closes the drawer when the page changes by another way than a pick", () => {
    const view = renderSidebar(true, true);
    expect(setNavVisible).not.toHaveBeenCalled();
    pathname.value = "/home";
    view.rerender(
      <DashboardSidebar hidden navVisible width={240} collapsedWidth={72} setNavVisible={setNavVisible} />
    );
    expect(setNavVisible).toHaveBeenCalledWith(false);
  });
});
