// The app's one field list: the menu card with a flush search row from 9 fields on, the kind of each field, the
// chosen one marked, disabled fields with their reason, "No fields match", a multiple pick that stays open; and the
// form selects (LayerFieldSelector) open it in place of their own list.
import { ThemeProvider } from "@mui/material/styles";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";
import { popoverSurface } from "@p4b/ui/theme/popoverSurface";

import type { LayerFieldType } from "@/lib/validations/layer";

import FieldMenu, { type FieldMenuField } from "@/components/common/FieldMenu";
import LayerFieldSelector from "@/components/map/common/LayerFieldSelector";

const theme = createAppTheme({ mode: "dark", locale: "en" });
const inTheme = (ui: React.ReactElement) => render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);

const FIELDS: FieldMenuField[] = [
  { name: "RW_WW", type: "number" },
  { name: "Strasse", type: "string" },
  { name: "HAUSNR", type: "integer" },
];
const MANY: FieldMenuField[] = [
  ...FIELDS,
  ...Array.from({ length: 7 }, (_, i) => ({ name: `extra_${i}`, type: "string" })),
];

const anchor = () => {
  const button = document.createElement("button");
  document.body.appendChild(button);
  return button;
};

function menu(props: Partial<React.ComponentProps<typeof FieldMenu<FieldMenuField>>> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  inTheme(
    <FieldMenu
      anchorEl={anchor()}
      onClose={onClose}
      fields={FIELDS}
      isSelected={(f) => f.name === "RW_WW"}
      onPick={onPick}
      {...props}
    />
  );
  return { onPick, onClose };
}

describe("FieldMenu", () => {
  it("lists the fields on the menu card, each with its kind, the chosen one marked", () => {
    menu();
    const card = screen.getByRole("listbox").closest(".MuiPaper-root") as HTMLElement;
    expect(card).toHaveStyle({ borderRadius: popoverSurface(theme).borderRadius });
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["123RW_WW", "AStrasse", "123HAUSNR"]);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");
    // A short list has no search.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("starts at its field's width (240 px under a narrower one) and grows with its labels up to 360 px", () => {
    const field = (width: number) => {
      const box = document.createElement("div");
      box.className = "MuiInputBase-root";
      Object.defineProperty(box, "offsetWidth", { value: width });
      const button = document.createElement("button");
      box.appendChild(button);
      document.body.appendChild(box);
      return button;
    };
    const card = () => screen.getByRole("listbox").closest(".MuiPaper-root") as HTMLElement;
    const { unmount } = inTheme(
      <FieldMenu
        anchorEl={field(260)}
        onClose={vi.fn()}
        fields={FIELDS}
        isSelected={() => false}
        onPick={vi.fn()}
      />
    );
    expect(card()).toHaveStyle({ minWidth: "260px", maxWidth: "360px", boxSizing: "border-box" });
    unmount();
    inTheme(
      <FieldMenu
        anchorEl={field(200)}
        onClose={vi.fn()}
        fields={FIELDS}
        isSelected={() => false}
        onPick={vi.fn()}
      />
    );
    expect(card()).toHaveStyle({ minWidth: "240px", maxWidth: "360px" });
  });

  it("has a flush search row from 9 fields on, which narrows the list and says when nothing matches", async () => {
    menu({ fields: MANY });
    const search = screen.getByRole("textbox", { name: "search_fields" });
    // A plain input in its row: no outlined box of its own.
    expect(search.closest(".MuiOutlinedInput-root")).toBeNull();
    // A search, not a form field: browsers and password managers suggest nothing over the list.
    expect(search.getAttribute("autocomplete")).toBe("off");
    expect(search.getAttribute("name")).toBe("menu-search");
    expect(search.getAttribute("spellcheck")).toBe("false");
    expect(search.getAttribute("autocorrect")).toBe("off");
    expect(search.getAttribute("data-1p-ignore")).toBe("true");
    expect(search.getAttribute("data-lpignore")).toBe("true");
    expect(search.getAttribute("data-form-type")).toBe("other");
    await userEvent.type(search, "haus");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["123HAUSNR"]);
    await userEvent.clear(search);
    await userEvent.type(search, "nothing like it");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("no_fields_match")).toBeDefined();
  });

  it("picks by keyboard: down from the search into the fields, Enter takes the first match", async () => {
    const { onPick, onClose } = menu({ fields: MANY });
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getAllByRole("option")[0]);
    await userEvent.keyboard("str");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["AStrasse"]);
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(FIELDS[1]);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a field the use cannot take disabled", async () => {
    const { onPick } = menu({
      disabledReason: (f) => (f.type === "string" ? "Only number fields" : undefined),
    });
    const strasse = screen.getAllByRole("option")[1];
    expect(strasse.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(strasse);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("a multiple pick keeps the list open and shows checkboxes", async () => {
    const { onPick, onClose } = menu({ multiple: true });
    await userEvent.click(screen.getAllByRole("option")[2]);
    expect(onPick).toHaveBeenCalledWith(FIELDS[2]);
    expect(onClose).not.toHaveBeenCalled();
    expect(within(screen.getAllByRole("option")[0]).getByRole("checkbox")).toBeDefined();
  });
});

describe("LayerFieldSelector", () => {
  const fields = FIELDS as LayerFieldType[];

  it("opens the field list under the select and picks a field", async () => {
    function Host() {
      const [field, setField] = useState<LayerFieldType | undefined>();
      return (
        <LayerFieldSelector fields={fields} selectedField={field} setSelectedField={setField} label="Field" />
      );
    }
    inTheme(<Host />);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.mouseDown(screen.getByRole("combobox"));
    await userEvent.click(within(screen.getByRole("listbox")).getByText("HAUSNR"));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox").textContent).toBe("HAUSNR");
  });

  it("a multiple select toggles fields and selects all", async () => {
    function Host() {
      const [picked, setPicked] = useState<LayerFieldType[] | undefined>([]);
      return (
        <LayerFieldSelector
          multiple
          fields={fields}
          selectedField={picked}
          setSelectedField={setPicked}
          label="Fields"
        />
      );
    }
    inTheme(<Host />);
    fireEvent.mouseDown(screen.getByRole("combobox"));
    await userEvent.click(within(screen.getByRole("listbox")).getByText("Strasse"));
    expect(screen.getByRole("combobox").textContent).toBe("Strasse");
    await userEvent.click(screen.getByText("select_all"));
    expect(screen.getByRole("combobox").textContent).toBe("RW_WW, ...");
  });
});
