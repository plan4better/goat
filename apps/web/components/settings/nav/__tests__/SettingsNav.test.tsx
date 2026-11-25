import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { declaredStyle } from "@/lib/__tests__/declaredStyle";

import SettingsNav, { WHITE_LABEL_OPEN_KEY } from "@/components/settings/nav/SettingsNav";
import { settingsNav } from "@/components/settings/nav/settingsNav";

/** Every render of White Label's fold and chevron: open or not, and how it moves. */
const renders = vi.hoisted(() => ({
  collapse: [] as { open: boolean | undefined; timeout: unknown }[],
  chevron: [] as { transform: unknown; transition: unknown }[],
}));
vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  const Collapse = (props: ComponentProps<typeof actual.Collapse>) => {
    renders.collapse.push({ open: props.in, timeout: props.timeout });
    return <actual.Collapse {...props} />;
  };
  return { ...actual, Collapse };
});
vi.mock("@p4b/ui/components/Icon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@p4b/ui/components/Icon")>();
  const Icon = (props: ComponentProps<typeof actual.Icon>) => {
    if (props.iconName === actual.ICON_NAME.CHEVRON_DOWN) {
      renders.chevron.push({ transform: props.style?.transform, transition: props.style?.transition });
    }
    return <actual.Icon {...props} />;
  };
  return { ...actual, Icon };
});

const renderNav = (pathname: string) =>
  render(
    <I18nextProvider i18n={commonI18n("en")}>
      <SettingsNav
        groups={settingsNav({
          pathname,
          roles: ["organization-owner"],
          features: { billing: true, whiteLabel: true },
          assistant: true,
          phone: false,
        })}
      />
    </I18nextProvider>
  );

describe("SettingsNav White Label", () => {
  beforeEach(() => {
    renders.collapse.length = 0;
    renders.chevron.length = 0;
    window.localStorage.clear();
  });

  it("folds White Label as the viewer left it without animating it shut on entry", () => {
    window.localStorage.setItem(WHITE_LABEL_OPEN_KEY, "0");
    renderNav("/settings/profile");
    // The server and the first client render draw it open; the render that
    // applies the stored "closed" must not move.
    expect(renders.collapse[0]).toEqual({ open: true, timeout: 0 });
    expect(renders.collapse.find((entry) => entry.open === false)).toEqual({ open: false, timeout: 0 });
    expect(renders.chevron.find((entry) => entry.transform === "none")?.transition).toBe("none");
  });

  it("animates a fold the viewer asks for", async () => {
    renderNav("/settings/profile");
    renders.collapse.length = 0;
    renders.chevron.length = 0;
    await userEvent.click(screen.getByRole("button", { name: "White Label" }));
    expect(renders.collapse.find((entry) => entry.open === false)).toEqual({ open: false, timeout: "auto" });
    expect(renders.chevron.find((entry) => entry.transform === "none")?.transition).toBe("transform 140ms");
  });

  it("writes White Label in the app's font, as Content's fold button does", () => {
    renderNav("/settings/profile");
    // A <button>, unlike the link rows: the browser would give it its own font.
    expect(declaredStyle(screen.getByRole("button", { name: "White Label" }), "font-family")).toBe("inherit");
  });
});

describe("SettingsNav focus", () => {
  it("rings a row the keyboard reaches, the current one too", async () => {
    renderNav("/settings/profile");
    const current = screen.getByRole("link", { name: "Profile", current: "page" });
    // jsdom computes only the `outline` shorthand.
    expect(getComputedStyle(current).outline).not.toContain("solid");
    await userEvent.tab();
    await expect(current).toHaveFocus();
    // MUI marks keyboard focus with `Mui-focusVisible` after asking the
    // element for `:focus-visible`, which jsdom answers from a heuristic that
    // earlier tests in the file can sway; the state is set here directly.
    current.classList.add("Mui-focusVisible");
    expect(getComputedStyle(current).outline).toMatch(/^2px solid /);
  });
});
