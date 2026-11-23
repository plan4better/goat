import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type SaveResult, StyleSaver, type StyleTransport } from "@/lib/style/save";
import type { PopupProperties } from "@/lib/validations/layer";

import { StyleEditor } from "@/components/map/panels/styleEditor/StyleEditor";
import { renderWithProviders } from "@/components/map/panels/styleEditor/__tests__/renderPanel";
import { EMPTY_DATA, useEditor, useStyleValue } from "@/components/map/panels/styleEditor/context";

import { HtmlModeCard } from "../HtmlModeCard";

vi.mock("@/hooks/map/CommonHooks", () => ({ default: () => ({ layerFields: [] }) }));
vi.mock("@/components/map/popover/sampleFeature", () => ({
  useSampleFeature: () => ({ feature: undefined }),
}));
// The code editor (loaded with next/dynamic) as a plain text box.
vi.mock("next/dynamic", () => ({
  default: () =>
    function HtmlModeEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
      return <textarea aria-label="html" value={value} onChange={(e) => onChange(e.target.value)} />;
    },
}));

const STORED = {
  version: "1.0.0",
  kind: "vector",
  symbol: { marker: { color: "#336699" } },
  popup: { mode: "html", html: "<b>{{ name }}</b>" },
} as LayerStyle;

const MESSAGE = "No field named nmae.";

/** The card over the store's popup HTML, as the popup section passes it. */
function Card() {
  const store = useEditor();
  const html = useStyleValue<string>("popup.html");
  const popup = { mode: "html", html, header: "standard" } as unknown as PopupProperties;
  return (
    <HtmlModeCard
      layerId="l1"
      layerName="Towns"
      popup={popup}
      onChange={(patch) => store.set("popup.html", patch.html)}
    />
  );
}

/** A transport whose answers the test gives. */
function shell() {
  const resolvers: Array<(r: SaveResult) => void> = [];
  const transport: StyleTransport = {
    save: () => new Promise((resolve) => resolvers.push(resolve)),
    load: async () => ({ document: STORED, revision: 1 }),
  };
  const store = new EditorStore({ saver: new StyleSaver({ transport, document: STORED, revision: 1 }) });
  renderWithProviders(
    <StyleEditor
      layer={{ id: "l1", name: "Towns", geometry: "point", kind: "vector" }}
      store={store}
      data={{ ...EMPTY_DATA, geometry: "point" }}
      map={null}
      mapZoom={12}>
      <Card />
    </StyleEditor>
  );
  const answer = async (result: SaveResult) => {
    await vi.advanceTimersByTimeAsync(0);
    resolvers.shift()?.(result);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { store, answer };
}

async function editAndSave(html: string) {
  const row = screen.getByText("popup_mode_html").parentElement as HTMLElement;
  fireEvent.click(within(row).getByRole("button"));
  fireEvent.change(await screen.findByRole("textbox", { name: "html" }), { target: { value: html } });
  fireEvent.click(screen.getByRole("button", { name: "save" }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HtmlModeCard", () => {
  it("an HTML the server takes back keeps the editor open with the draft and the issue", async () => {
    const { store, answer } = shell();
    await editAndSave("<b>{{ nmae }}</b>");
    await act(() =>
      answer({
        ok: true,
        document: STORED,
        revision: 1,
        issues: [{ level: "error", code: "unknown_field", path: "/popup/html", message: MESSAGE }],
      })
    );
    expect(store.get("popup.html")).toBe("<b>{{ name }}</b>");
    expect((screen.getByRole("textbox", { name: "html" }) as HTMLTextAreaElement).value).toBe(
      "<b>{{ nmae }}</b>"
    );
    expect(screen.getByText(MESSAGE)).toBeDefined();
  });

  it("an HTML the server stores closes the editor", async () => {
    const { store, answer } = shell();
    await editAndSave("<b>{{ name }}!</b>");
    await act(() => answer({ ok: true, document: store.document, revision: 2, issues: [] }));
    expect(store.get("popup.html")).toBe("<b>{{ name }}!</b>");
    expect(screen.queryByRole("textbox", { name: "html" })).toBeNull();
  });
});
