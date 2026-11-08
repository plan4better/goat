import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import RoleMenu from "@/components/settings/common/RoleMenu";
import RolePill from "@/components/settings/common/RolePill";

const de = commonI18n("de");

describe("RoleMenu", () => {
  it("shows the role, checks it in the menu and explains every role", async () => {
    render(
      <I18nextProvider i18n={de}>
        <RoleMenu
          value="organization-editor"
          label="Rolle von Anna Weber"
          onChange={vi.fn()}
          options={[
            { role: "organization-admin", disabledReason: "Kein Bearbeiter-Platz frei" },
            { role: "organization-editor" },
            { role: "organization-viewer" },
          ]}
        />
      </I18nextProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: "Rolle von Anna Weber: Bearbeiter" }));
    const editor = screen.getByRole("menuitemradio", { name: /^Bearbeiter/ });
    await expect(editor).toHaveAttribute("aria-checked", "true");
    expect(editor).toHaveTextContent("Erstellt und bearbeitet Projekte, Workflows, Layouts und Dashboards.");
    const admin = screen.getByRole("menuitemradio", { name: /^Admin/ });
    await expect(admin).toHaveAttribute("aria-disabled", "true");
    expect(admin).toHaveTextContent("Kein Bearbeiter-Platz frei");
    expect(admin).not.toHaveTextContent("Verwaltet Mitglieder");
  });

  it("reports a different role and ignores the current one", async () => {
    const onChange = vi.fn();
    render(
      <I18nextProvider i18n={de}>
        <RoleMenu
          value="organization-editor"
          label="Rolle von Anna Weber"
          onChange={onChange}
          options={[
            { role: "organization-admin" },
            { role: "organization-editor" },
            { role: "organization-viewer" },
          ]}
        />
      </I18nextProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: /Rolle von Anna Weber/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Bearbeiter/ }));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Rolle von Anna Weber/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Betrachter/ }));
    expect(onChange).toHaveBeenCalledWith("organization-viewer");
  });

  it("lets the keyboard reach a disabled role for its reason, but never picks it", async () => {
    const onChange = vi.fn();
    render(
      <I18nextProvider i18n={de}>
        <RoleMenu
          value="organization-viewer"
          label="Rolle von Anna Weber"
          onChange={onChange}
          options={[
            { role: "organization-admin", disabledReason: "Kein Bearbeiter-Platz frei" },
            { role: "organization-editor", disabledReason: "Kein Bearbeiter-Platz frei" },
            { role: "organization-viewer" },
          ]}
        />
      </I18nextProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: /Rolle von Anna Weber/ }));
    // The open menu focuses the checked role; Home goes to the first, disabled one.
    await userEvent.keyboard("{Home}");
    const admin = screen.getByRole("menuitemradio", { name: /^Admin/ });
    await expect(admin).toHaveFocus();
    await userEvent.keyboard(" ");
    await userEvent.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});

describe("RoleMenu focus", () => {
  it("rings its trigger when the keyboard reaches it", async () => {
    render(
      <I18nextProvider i18n={de}>
        <RoleMenu
          value="organization-editor"
          label="Rolle von Anna Weber"
          onChange={vi.fn()}
          options={[{ role: "organization-editor" }]}
        />
      </I18nextProvider>
    );
    const trigger = screen.getByRole("button", { name: /Rolle von Anna Weber/ });
    // jsdom computes only the `outline` shorthand.
    expect(getComputedStyle(trigger).outline).not.toContain("solid");
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    // MUI marks keyboard focus with `Mui-focusVisible` after asking the
    // element for `:focus-visible`, which jsdom answers from a heuristic that
    // earlier tests in the file can sway; the state is set here directly.
    trigger.classList.add("Mui-focusVisible");
    expect(getComputedStyle(trigger).outline).toMatch(/^2px solid /);
  });
});

describe("RolePill", () => {
  it("names a static role and why it is static", () => {
    render(
      <I18nextProvider i18n={de}>
        <RolePill role="organization-owner" reason="Die Rolle des Eigentümers lässt sich nicht ändern." />
      </I18nextProvider>
    );
    // An image role, as a plain span may not carry a name of its own.
    expect(
      screen.getByRole("img", { name: "Eigentümer. Die Rolle des Eigentümers lässt sich nicht ändern." })
    ).toBeInTheDocument();
  });
});
