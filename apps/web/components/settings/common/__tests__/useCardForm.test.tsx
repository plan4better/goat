import { ThemeProvider } from "@mui/material/styles";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import LabeledField from "@/components/common/LabeledField";
import { warningTextInk } from "@/components/modals/content/ContentDialogChrome";
import CardSaveBar from "@/components/settings/common/CardSaveBar";
import { useCardForm } from "@/components/settings/common/useCardForm";

// State is read off the DOM rather than through jest-dom's `toBeDisabled`,
// `toBeEnabled` and `toHaveValue`: the repo's ESLint setup reads those as
// Playwright's (async) matchers of the same name.

const schema = z.object({
  name: z.string().trim().min(1, "settings_teams_name_required").max(50, "settings_teams_name_help"),
});
type Values = z.infer<typeof schema>;

function Harness({ values, save }: { values?: Values; save: (next: Values) => Promise<boolean> }) {
  const card = useCardForm(schema, values, save);
  return (
    <form id="card" onSubmit={card.submit}>
      <LabeledField id="name" label="Teamname" {...card.form.register("name")} error={card.errorOf("name")} />
      <CardSaveBar
        formId="card"
        dirty={card.dirty}
        valid={card.valid}
        saving={card.saving}
        onDiscard={card.discard}
      />
    </form>
  );
}

/** A card whose save reloads the saved values before it returns, as the pages'
 * `await mutate()` does: `stored` is the server's copy of what was sent (core
 * stores a picked picture and returns its URL), `gate` holds the save open. */
function ReloadingHarness({ stored, gate }: { stored: (next: Values) => Values; gate: Promise<void> }) {
  const [values, setValues] = useState<Values>({ name: "Planung" });
  return (
    <>
      <Harness
        values={values}
        save={async (next) => {
          setValues(stored(next));
          await gate;
          return true;
        }}
      />
      <p>{`Server: ${values.name}`}</p>
    </>
  );
}

const wrap = (node: ReactNode) => <I18nextProvider i18n={commonI18n("de")}>{node}</I18nextProvider>;

const renderHarness = (save: (next: Values) => Promise<boolean>) =>
  render(wrap(<Harness values={{ name: "Planung" }} save={save} />));

const nameInput = () => screen.getByLabelText("Teamname") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "Speichern" }) as HTMLButtonElement;

const beforeUnloadPrevented = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe("useCardForm and CardSaveBar", () => {
  it("writes 'unsaved' in the amber that reads on paper", () => {
    const theme = createAppTheme({ mode: "light", locale: "de" });
    render(
      <ThemeProvider theme={theme}>
        {wrap(<CardSaveBar formId="card" dirty valid saving={false} onDiscard={vi.fn()} />)}
      </ThemeProvider>
    );
    // `warning.main` itself is 1.8:1 on white.
    expect(screen.getByRole("status")).toHaveStyle({ color: warningTextInk(theme) });
  });

  it("starts saved, with Speichern off and no Verwerfen", () => {
    renderHarness(vi.fn());
    expect(screen.getByRole("status")).toHaveTextContent("Alles gespeichert");
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Verwerfen" })).toBeNull();
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("marks a draft, guards the tab and puts the saved value back on Verwerfen", async () => {
    renderHarness(vi.fn());
    await userEvent.type(nameInput(), " Nord");
    expect(screen.getByRole("status")).toHaveTextContent("Ungespeicherte Änderungen");
    expect(saveButton().disabled).toBe(false);
    expect(beforeUnloadPrevented()).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect(nameInput().value).toBe("Planung");
    expect(screen.getByRole("status")).toHaveTextContent("Alles gespeichert");
  });

  it("shows a field's error once it was changed and keeps Speichern off while invalid", async () => {
    renderHarness(vi.fn());
    await userEvent.clear(nameInput());
    expect(screen.getByText("Geben Sie einen Namen ein.")).toBeInTheDocument();
    expect(saveButton().disabled).toBe(true);
  });

  it("says why Speichern is off when a saved value is invalid and another field changes", async () => {
    // An account saved without a name: only the picture changes, the name is untouched.
    const pictureSchema = schema.extend({ avatar: z.string() });
    const saved = { name: "", avatar: "" };
    const save = vi.fn().mockResolvedValue(true);
    function PictureHarness() {
      const card = useCardForm(pictureSchema, saved, save);
      return (
        <form id="card" onSubmit={card.submit}>
          <button
            type="button"
            onClick={() =>
              card.form.setValue("avatar", "data:image/png;base64,x", {
                shouldDirty: true,
                shouldValidate: true,
              })
            }>
            Bild
          </button>
          <LabeledField
            id="name"
            label="Teamname"
            {...card.form.register("name")}
            error={card.errorOf("name")}
          />
          <CardSaveBar
            formId="card"
            dirty={card.dirty}
            valid={card.valid}
            saving={card.saving}
            onDiscard={card.discard}
          />
        </form>
      );
    }
    render(wrap(<PictureHarness />));
    // Nothing changed yet: no error is pressed on the reader.
    expect(screen.queryByText("Geben Sie einen Namen ein.")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Bild" }));
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("Geben Sie einen Namen ein.")).toBeInTheDocument();
  });

  it("saves the trimmed values and returns to saved", async () => {
    const save = vi.fn().mockResolvedValue(true);
    renderHarness(save);
    await userEvent.clear(nameInput());
    await userEvent.type(nameInput(), "  Nord  ");
    await userEvent.click(saveButton());
    expect(save).toHaveBeenCalledWith({ name: "Nord" });
    expect(await screen.findByText("Alles gespeichert")).toBeInTheDocument();
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("keeps the draft when the save fails", async () => {
    const save = vi.fn().mockResolvedValue(false);
    renderHarness(save);
    await userEvent.type(nameInput(), "x");
    await userEvent.click(saveButton());
    expect(save).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Ungespeicherte Änderungen");
    expect(nameInput().value).toBe("Planungx");
  });

  it("fills the fields once the saved values arrive", async () => {
    const { rerender } = render(wrap(<Harness save={vi.fn()} />));
    expect(nameInput().value).toBe("");
    rerender(wrap(<Harness values={{ name: "Planung" }} save={vi.fn()} />));
    expect(await screen.findByDisplayValue("Planung")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Alles gespeichert");
  });

  it("shows the values the save reloaded, not the draft it sent", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    render(wrap(<ReloadingHarness stored={(next) => ({ name: `${next.name} GmbH` })} gate={gate} />));
    await userEvent.clear(nameInput());
    await userEvent.type(nameInput(), "Nord");
    await userEvent.click(saveButton());
    // The reloaded values render while the save still runs and the form is dirty.
    expect(await screen.findByText("Server: Nord GmbH")).toBeInTheDocument();
    expect(nameInput().value).toBe("Nord");
    await act(async () => open());
    await waitFor(() => expect(nameInput().value).toBe("Nord GmbH"));
    expect(screen.getByRole("status")).toHaveTextContent("Alles gespeichert");
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("keeps the draft when the saved values change while it is dirty", async () => {
    const { rerender } = render(wrap(<Harness values={{ name: "Planung" }} save={vi.fn()} />));
    await userEvent.type(nameInput(), "x");
    rerender(wrap(<Harness values={{ name: "Süd" }} save={vi.fn()} />));
    expect(nameInput().value).toBe("Planungx");
    expect(screen.getByRole("status")).toHaveTextContent("Ungespeicherte Änderungen");
    await userEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect(nameInput().value).toBe("Süd");
    expect(screen.getByRole("status")).toHaveTextContent("Alles gespeichert");
  });
});
