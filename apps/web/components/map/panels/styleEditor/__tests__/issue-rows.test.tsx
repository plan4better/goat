import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type SaveResult, type StyleIssue, StyleSaver, type StyleTransport } from "@/lib/style/save";

import { StyleEditor } from "@/components/map/panels/styleEditor/StyleEditor";
import { EMPTY_DATA } from "@/components/map/panels/styleEditor/context";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, renderWithProviders } from "./renderPanel";

const MESSAGE = "No icon named goat:nope.";

function shell(document: LayerStyle) {
  const resolvers: Array<(r: SaveResult) => void> = [];
  const transport: StyleTransport = {
    save: () => new Promise((resolve) => resolvers.push(resolve)),
    load: async () => ({ document, revision: 1 }),
  };
  const store = new EditorStore({ saver: new StyleSaver({ transport, document, revision: 1 }) });
  renderWithProviders(
    <StyleEditor
      layer={{ id: "l1", name: "Schools", geometry: "point", kind: "vector" }}
      store={store}
      data={{ ...EMPTY_DATA, geometry: "point" }}
      map={null}
      mapZoom={12}>
      <SymbolSection />
    </StyleEditor>
  );
  const answer = async (issues: StyleIssue[]) => {
    store.saver.saveNow();
    await vi.advanceTimersByTimeAsync(0);
    resolvers.shift()?.({ ok: true, document: store.document, revision: 2, issues });
    await vi.advanceTimersByTimeAsync(0);
  };
  return { store, answer };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("issues on rows", () => {
  it("a part row shows a dot for an issue inside it, and its editor shows the issue with its fix", async () => {
    const { store, answer } = shell({
      version: 1,
      kind: "vector",
      symbol: { marker: { shape: "icon", icon: "goat:nope", color: "#1a6b4d", size: 8 } },
    } as LayerStyle);
    act(() => store.set("symbol.marker.size", 9));
    await act(() =>
      answer([
        {
          level: "error",
          code: "unknown_icon",
          path: "/symbol/marker/icon",
          message: MESSAGE,
          fix: { op: "set", path: "/symbol/marker/icon", value: "goat:circle-solid" },
        },
      ])
    );
    expect(screen.getByLabelText(MESSAGE)).toBeDefined();
    await openGroup("style_editor.part_icon");
    expect(screen.getByText(MESSAGE)).toBeDefined();
    await act(async () => screen.getByRole("button", { name: "style_editor.fix_set" }).click());
    expect(store.get("symbol.marker.icon")).toBe("goat:circle-solid");
  });

  it("the label editor shows an issue of the label text", async () => {
    const message = "Fields are written {{ name }}.";
    const { store, answer } = shell({
      version: 1,
      kind: "vector",
      symbol: { marker: { shape: "circle", color: "#1a6b4d", size: 8 }, label: { text: "{name" } },
    } as LayerStyle);
    act(() => store.set("symbol.marker.size", 9));
    await act(() =>
      answer([{ level: "error", code: "template_syntax", path: "/symbol/label/text", message }])
    );
    await openGroup("style_editor.part_label");
    expect(screen.getByText(message)).toBeDefined();
  });
});
