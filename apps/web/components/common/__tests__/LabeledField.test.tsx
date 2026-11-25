import { MenuItem } from "@mui/material";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import LabeledField from "@/components/common/LabeledField";

// jest-dom's `toHaveAttribute` and `toHaveFocus` are awaited: the repo's ESLint
// setup reads them as Playwright's async matchers of the same name.

describe("LabeledField", () => {
  it("ties its bold label to the field and shows the help with a counter", () => {
    render(
      <I18nextProvider i18n={commonI18n("de")}>
        <LabeledField
          id="team-name"
          label="Teamname"
          required
          help="Höchstens 50 Zeichen."
          counter={{ value: 12, max: 50 }}
        />
      </I18nextProvider>
    );
    const input = screen.getByLabelText(/Teamname/);
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(screen.getByText("Höchstens 50 Zeichen.")).toBeInTheDocument();
    expect(screen.getByText("12/50")).toBeInTheDocument();
  });

  it("shows the error in place of the help", () => {
    render(
      <I18nextProvider i18n={commonI18n("de")}>
        <LabeledField
          id="n"
          label="Teamname"
          help="Höchstens 50 Zeichen."
          error="Geben Sie einen Namen ein."
        />
      </I18nextProvider>
    );
    expect(screen.getByText("Geben Sie einen Namen ein.")).toBeInTheDocument();
    expect(screen.queryByText("Höchstens 50 Zeichen.")).toBeNull();
    expect(screen.getByLabelText("Teamname").getAttribute("aria-invalid")).toBe("true");
  });

  it("names its select by the label and puts required and the help on the combobox", async () => {
    render(
      <I18nextProvider i18n={commonI18n("de")}>
        <LabeledField
          id="provider"
          label="Anbieter"
          required
          select
          value="openai"
          onChange={vi.fn()}
          help="Wählen Sie, wer die Anfragen beantwortet.">
          <MenuItem value="openai">OpenAI</MenuItem>
        </LabeledField>
      </I18nextProvider>
    );
    const combobox = screen.getByRole("combobox", { name: /Anbieter/ });
    await expect(combobox).toHaveAttribute("aria-required", "true");
    expect(combobox).toHaveAccessibleDescription("Wählen Sie, wer die Anfragen beantwortet.");
    await userEvent.click(screen.getByText("Anbieter"));
    await expect(combobox).toHaveFocus();
  });

  it("marks an invalid select on the combobox", async () => {
    render(
      <I18nextProvider i18n={commonI18n("de")}>
        <LabeledField
          id="p"
          label="Anbieter"
          select
          value=""
          onChange={vi.fn()}
          error="Wählen Sie einen Anbieter.">
          <MenuItem value="openai">OpenAI</MenuItem>
        </LabeledField>
      </I18nextProvider>
    );
    await expect(screen.getByRole("combobox", { name: /Anbieter/ })).toHaveAttribute("aria-invalid", "true");
  });

  it("is a labelled textarea when multiline", async () => {
    render(
      <I18nextProvider i18n={commonI18n("de")}>
        <LabeledField id="d" label="Beschreibung" multiline minRows={3} required />
      </I18nextProvider>
    );
    const textarea = screen.getByLabelText(/Beschreibung/);
    expect(textarea.tagName).toBe("TEXTAREA");
    await expect(textarea).toHaveAttribute("aria-required", "true");
  });
});
