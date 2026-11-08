import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import ConfirmModal from "@/components/modals/Confirm";
import SwitchRow from "@/components/settings/common/SwitchRow";

// jest-dom's `toBeDisabled`, `toHaveAttribute`, `toHaveFocus` and the like are
// awaited (or the state is read off the DOM): the repo's ESLint setup reads
// them as Playwright's async matchers of the same name.

describe("SwitchRow", () => {
  it("is a switch named by its label and described by its line", async () => {
    const onChange = vi.fn();
    const Row = () => {
      const [on, setOn] = useState(false);
      return (
        <SwitchRow
          id="fallback"
          label="Auf GOAT AI ausweichen"
          line="Werden gekennzeichnet."
          checked={on}
          onChange={(next) => {
            setOn(next);
            onChange(next);
          }}
        />
      );
    };
    render(<Row />);
    const toggle = screen.getByRole("switch", { name: "Auf GOAT AI ausweichen" });
    expect(toggle).toHaveAccessibleDescription("Werden gekennzeichnet.");
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("toggles when its label is clicked", async () => {
    const onChange = vi.fn();
    render(<SwitchRow id="fallback" label="Auf GOAT AI ausweichen" checked={false} onChange={onChange} />);
    await userEvent.click(screen.getByText("Auf GOAT AI ausweichen"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("ConfirmModal", () => {
  it("asks for the match text under its own label", async () => {
    const onConfirm = vi.fn();
    render(
      <I18nextProvider i18n={commonI18n("de")}>
        <ConfirmModal
          open
          title="Konto löschen"
          body={
            <ul>
              <li>eins</li>
            </ul>
          }
          matchText="anna@example.com"
          matchLabel="Geben Sie zur Bestätigung anna@example.com ein."
          confirmText="Konto endgültig löschen"
          onConfirm={onConfirm}
        />
      </I18nextProvider>
    );
    const confirm = screen.getByRole("button", { name: "Konto endgültig löschen" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    // Decision 7: the label above the field, not floating in its border.
    const label = screen.getByText("Geben Sie zur Bestätigung anna@example.com ein.");
    expect(label.tagName).toBe("LABEL");
    expect(label.closest(".MuiFormControl-root")).toBeNull();
    await userEvent.type(
      screen.getByLabelText("Geben Sie zur Bestätigung anna@example.com ein."),
      "anna@example.com"
    );
    expect(confirm.disabled).toBe(false);
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalled();
    // A list in the body is valid markup: the body is a div, not a <p>.
    expect(screen.getByText("eins").closest("p")).toBeNull();
  });
});
