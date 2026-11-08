import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { declaredStyle } from "@/lib/__tests__/declaredStyle";

import RadioCardGroup, { type RadioCardOption } from "@/components/settings/common/RadioCardGroup";

// State is read off the DOM rather than through jest-dom's `toHaveAttribute`
// and `toHaveFocus`: the repo's ESLint setup reads those as Playwright's
// (async) matchers of the same name.

type Role = "admin" | "editor" | "viewer";
const OPTIONS: RadioCardOption<Role>[] = [
  {
    value: "admin",
    label: "Admin",
    line: "Verwaltet Mitglieder.",
    disabled: true,
    disabledReason: "Kein Bearbeiter-Platz frei",
    figure: "0 von 5 frei",
  },
  { value: "editor", label: "Bearbeiter", line: "Erstellt Projekte." },
  { value: "viewer", label: "Betrachter", line: "Öffnet Geteiltes." },
];

function Group({ onDisabledClick }: { onDisabledClick?: (value: Role) => void }) {
  const [value, setValue] = useState<Role>("editor");
  return (
    <RadioCardGroup
      label="Rolle"
      value={value}
      options={OPTIONS}
      onChange={setValue}
      onDisabledClick={onDisabledClick}
    />
  );
}

const radio = (name: RegExp) => screen.getByRole("radio", { name });

describe("RadioCardGroup", () => {
  it("is a radio group with one checked card and the reason on a disabled one", () => {
    render(<Group />);
    expect(screen.getByRole("radiogroup", { name: "Rolle" })).toBeInTheDocument();
    expect(radio(/^Bearbeiter/).getAttribute("aria-checked")).toBe("true");
    const admin = radio(/^Admin/);
    expect(admin.getAttribute("aria-disabled")).toBe("true");
    expect(admin).toHaveTextContent("Kein Bearbeiter-Platz frei");
    expect(admin).not.toHaveTextContent("Verwaltet Mitglieder.");
    expect(admin).toHaveTextContent("0 von 5 frei");
  });

  it("moves with the arrow keys, skipping disabled cards, and has one tab stop", async () => {
    render(<Group />);
    const editor = radio(/^Bearbeiter/);
    expect(editor.getAttribute("tabindex")).toBe("0");
    expect(radio(/^Betrachter/).getAttribute("tabindex")).toBe("-1");
    editor.focus();
    await userEvent.keyboard("{ArrowDown}");
    const viewer = radio(/^Betrachter/);
    expect(document.activeElement).toBe(viewer);
    expect(viewer.getAttribute("aria-checked")).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(radio(/^Bearbeiter/));
  });

  it("draws a focus ring on the card MUI marks as keyboard-focused", () => {
    render(<Group />);
    const viewer = radio(/^Betrachter/);
    // `outline`, not `outlineStyle`: jsdom keeps the shorthand unexpanded.
    expect(getComputedStyle(viewer).outline).not.toMatch(/solid/);
    // MUI's own class, set by hand: jsdom's :focus-visible matches a scripted
    // focus() and not a Tab, so ButtonBase cannot be made to set it faithfully.
    viewer.classList.add("Mui-focusVisible");
    expect(getComputedStyle(viewer).outline).toMatch(/^2px solid /);
  });

  it("writes its cards in the app's font, not the browser's button font", () => {
    render(<Group />);
    // A bare ButtonBase is a <button>, which the browser gives its own font;
    // the theme's typography only inherits, so every label inside took it.
    expect(declaredStyle(radio(/^Bearbeiter/), "font-family")).toBe("inherit");
  });

  it("does not pick a disabled card, and says why on a click", async () => {
    const onDisabledClick = vi.fn();
    render(<Group onDisabledClick={onDisabledClick} />);
    await userEvent.click(radio(/^Admin/));
    expect(onDisabledClick).toHaveBeenCalledWith("admin");
    expect(radio(/^Bearbeiter/).getAttribute("aria-checked")).toBe("true");
  });
});
