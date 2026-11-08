import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import EmailChipsInput, { splitAddresses } from "@/components/settings/common/EmailChipsInput";

function Field({
  problems = {},
  onSubmitEmpty,
}: {
  problems?: Record<string, string>;
  onSubmitEmpty?: () => void;
}) {
  const [value, setValue] = useState<string[]>([]);
  return (
    <I18nextProvider i18n={commonI18n("de")}>
      <EmailChipsInput
        id="emails"
        label="E-Mail-Adressen"
        value={value}
        onChange={setValue}
        problems={problems}
        placeholder="name@beispiel.example, weitere durch Komma"
        placeholderMore="Weitere Adresse"
        help="Mehrere Adressen mit Komma trennen."
        onSubmitEmpty={onSubmitEmpty}
      />
      <output data-testid="value">{value.join("|")}</output>
    </I18nextProvider>
  );
}

const value = () => screen.getByTestId("value").textContent;

describe("splitAddresses", () => {
  it("splits on commas, semicolons and spaces, trims and lowercases", () => {
    expect(splitAddresses(" A@x.de, b@x.de;C@x.de  ,, ")).toEqual(["a@x.de", "b@x.de", "c@x.de"]);
  });
});

describe("EmailChipsInput", () => {
  it("ends an address at a comma, a space or Enter", async () => {
    render(<Field />);
    const input = screen.getByLabelText("E-Mail-Adressen");
    await userEvent.type(input, "Anna@Example.com,ben@example.com ");
    await userEvent.type(input, "carl@example.com{Enter}");
    expect(value()).toBe("anna@example.com|ben@example.com|carl@example.com");
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute("placeholder", "Weitere Adresse");
  });

  it("splits a pasted list and keeps every address once", async () => {
    render(<Field />);
    const input = screen.getByLabelText("E-Mail-Adressen");
    await userEvent.click(input);
    await userEvent.paste("A@x.de, a@x.de;b@x.de  ");
    expect(value()).toBe("a@x.de|b@x.de");
  });

  it("pastes at the caret, so a pasted part completes the typed address", async () => {
    render(<Field />);
    const input = screen.getByLabelText("E-Mail-Adressen");
    await userEvent.type(input, "Anna@.de");
    // The caret back before ".de": the paste lands there, not at the end.
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    await userEvent.paste("x");
    expect(value()).toBe("anna@x.de");
    await expect(input).toHaveValue("");
  });

  it("adds no address twice across typing and pasting, nor an empty one", async () => {
    render(<Field />);
    const input = screen.getByLabelText("E-Mail-Adressen");
    await userEvent.type(input, "B@x.de; ,");
    await userEvent.paste(" b@X.de,,c@x.de ; ");
    expect(value()).toBe("b@x.de|c@x.de");
    expect(document.querySelectorAll(".MuiChip-root")).toHaveLength(2);
  });

  it("removes a chip from the keyboard and gives the focus back to the field", async () => {
    render(<Field />);
    const input = screen.getByLabelText("E-Mail-Adressen");
    await userEvent.type(input, "a@x.de,b@x.de,");
    await userEvent.tab({ shift: true });
    await expect(screen.getByRole("button", { name: /^b@x\.de/ })).toHaveFocus();
    await userEvent.keyboard("{Delete}");
    expect(value()).toBe("a@x.de");
    await expect(input).toHaveFocus();
  });

  it("removes the last address on Backspace in the empty field and takes the typed text on blur", async () => {
    render(<Field />);
    const input = screen.getByLabelText("E-Mail-Adressen");
    await userEvent.type(input, "a@x.de,b@x.de,");
    await userEvent.type(input, "{Backspace}");
    expect(value()).toBe("a@x.de");
    await userEvent.type(input, "c@x.de");
    await userEvent.tab();
    expect(value()).toBe("a@x.de|c@x.de");
  });

  it("marks a problem address red and names its reason in the help", async () => {
    render(<Field problems={{ nope: "keine E-Mail-Adresse" }} />);
    await userEvent.type(screen.getByLabelText("E-Mail-Adressen"), "nope,");
    // The chip's label, not the harness's <output>, which shows "nope" too.
    await expect(
      screen.getByText("nope", { selector: ".MuiChip-label" }).closest(".MuiChip-root")
    ).toHaveAttribute("data-invalid", "true");
    expect(screen.getByText("nope: keine E-Mail-Adresse")).toBeInTheDocument();
  });

  it("sends on Enter in the empty field", async () => {
    const onSubmitEmpty = vi.fn();
    render(<Field onSubmitEmpty={onSubmitEmpty} />);
    await userEvent.type(screen.getByLabelText("E-Mail-Adressen"), "{Enter}");
    expect(onSubmitEmpty).toHaveBeenCalledTimes(1);
  });
});
