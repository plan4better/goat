// Renders style panel components the way the panel does: a store over a fake transport, the layer's data, the map
// zoom, MUI's theme and an i18next instance without resources (every text is its key).
import { ThemeProvider, createTheme } from "@mui/material";
import { type RenderResult, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import type { ReactElement } from "react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { expect } from "vitest";

import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { StyleSaver, type StyleTransport } from "@/lib/style/save";

import { EMPTY_DATA, type StyleData, StyleEditorProvider } from "@/components/map/panels/styleEditor/context";

const i18n = i18next.createInstance();
void i18n
  .use(initReactI18next)
  .init({ lng: "en", resources: {}, initImmediate: false, react: { useSuspense: false } });

/** Answers every save at once with the sent document. */
export function echoTransport(): StyleTransport & { saves: LayerStyle[] } {
  let revision = 1;
  const saves: LayerStyle[] = [];
  return {
    saves,
    save: async (body) => {
      saves.push(body.document);
      revision += 1;
      return { ok: true, document: body.document, revision, issues: [] };
    },
    load: async () => ({ document: saves[saves.length - 1], revision }),
  };
}

export function renderPanel(
  ui: ReactElement,
  opts: {
    document?: LayerStyle;
    data?: Partial<StyleData>;
    transport?: StyleTransport;
    mapZoom?: number;
    map?: unknown;
  } = {}
): RenderResult & { store: EditorStore } {
  const document = opts.document ?? ({ version: 1, kind: "vector" } as LayerStyle);
  const saver = new StyleSaver({ transport: opts.transport ?? echoTransport(), document, revision: 1 });
  const store = new EditorStore({ saver });
  const data: StyleData = { ...EMPTY_DATA, ...opts.data };
  const result = render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider theme={createTheme()}>
        <StyleEditorProvider
          store={store}
          data={data}
          mapZoom={opts.mapZoom ?? 12}
          map={(opts.map ?? null) as never}>
          {ui}
        </StyleEditorProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
  return { ...result, store };
}

/** Theme and i18n only, for components that bring their own store (the editor shell). */
export function renderWithProviders(ui: ReactElement): RenderResult {
  return render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider theme={createTheme()}>{ui}</ThemeProvider>
    </I18nextProvider>
  );
}

/** Opens the editor of a group row (Fill, Outline, …) by its label. */
export async function openGroup(label: string): Promise<void> {
  const row = screen.getByText(label).parentElement as HTMLElement;
  await userEvent.click(within(row).getAllByRole("button")[0]);
}

/** Picks `option` from the dropdown of the row labeled `label`; choice labels fall back to the raw value without copy. */
export async function choose(label: string, current: string, option: string): Promise<void> {
  const row = screen.getByText(label).parentElement as HTMLElement;
  const select = within(row).getByRole("combobox");
  expect(select.textContent).toBe(current);
  await userEvent.click(select);
  await userEvent.click(within(screen.getByRole("listbox")).getByText(option));
}

/** Sets a color the way a user types it: opens the picker from the color field in `container` and types `hex` into the
 * picker's text box (shown as Hex). */
export async function pickColor(container: HTMLElement, hex: string): Promise<void> {
  window.localStorage.removeItem("goat.color-format");
  await userEvent.click(within(container).getByRole("button", { name: "style_editor.pick_color" }));
  const box = screen.getAllByRole("textbox", { name: "color_value" }).at(-1) as HTMLElement;
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: hex } });
}
