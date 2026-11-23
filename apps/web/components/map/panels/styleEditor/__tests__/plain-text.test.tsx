// Names the editor puts into its texts (field, style, layer and icon names, typed searches) read as they are: i18next
// escapes interpolated values for HTML unless a call says otherwise, and the editor prints its texts as React text or
// sends them to the server, so every such call passes `PLAIN`.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { HeatmapSection } from "@/components/map/panels/styleEditor/sections/HeatmapSection";

import { i18n, renderPanel } from "./renderPanel";

const NAME = `Einwohner/km² & <"O'Brien">`;

describe("names in the editor's texts", () => {
  it("a field name in a menu reads as it is", async () => {
    i18n.addResource("en", "common", "style_editor.by_field", "By {{field}}");
    renderPanel(
      <PopoverProvider>
        <HeatmapSection />
      </PopoverProvider>,
      {
        document: { version: "1.0.0", kind: "vector", render: { type: "heatmap" } } as LayerStyle,
        data: {
          geometry: "point",
          fields: [{ name: "density", type: "number", label: NAME }],
          fieldTypes: { density: "number" },
        },
      }
    );
    const row = screen.getByText("style_editor.weight").parentElement as HTMLElement;
    await userEvent.click(within(row).getByRole("combobox"));
    expect(within(screen.getByRole("listbox")).getByText(`By ${NAME}`)).toBeDefined();
  });
});

// Interpolation values that are numbers (or numbers written out) and need no option; every other value is a name or a
// translated text and needs `PLAIN`.
const NUMBER_PARAMS = new Set([
  "n",
  "count",
  "zoom",
  "from",
  "until",
  "min",
  "max",
  "total",
  "shown",
  "size",
  "resolution",
  "width",
  "lines",
  "chars",
  "k",
  "storey",
  "features",
  "time",
  "hex",
  "defaultValue",
]);

const ROOTS = ["components/map/panels/styleEditor", "components/map/panels/style"];
const WEB = path.join(__dirname, "..", "..", "..", "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return name === "__tests__" ? [] : sources(file);
    return /\.tsx?$/.test(name) ? [file] : [];
  });
}

/** `source` split at its commas outside brackets and strings, from `from` to the bracket that closes there; with the
 * index past that bracket. */
function parts(source: string, from: number): { parts: string[]; end: number } {
  const found: string[] = [];
  let depth = 1;
  let part = "";
  let j = from;
  for (; j < source.length && depth; j += 1) {
    const c = source[j];
    if ("\"'`".includes(c)) {
      let k = j + 1;
      for (; k < source.length && source[k] !== c; k += 1) if (source[k] === "\\") k += 1;
      part += source.slice(j, k + 1);
      j = k;
      continue;
    }
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    if (depth === 0 || (depth === 1 && c === ",")) {
      found.push(part);
      part = "";
    } else part += c;
  }
  return { parts: found.map((p) => p.trim()).filter(Boolean), end: j };
}

/** Each `t(...)` call of `source`: its line, its text and its arguments. */
function calls(source: string): Array<{ line: number; text: string; args: string[] }> {
  const found: Array<{ line: number; text: string; args: string[] }> = [];
  const start = /(?<![\w.])t\(/g;
  for (let m = start.exec(source); m; m = start.exec(source)) {
    const { parts: args, end } = parts(source, m.index + 2);
    found.push({ line: source.slice(0, m.index).split("\n").length, text: source.slice(m.index, end), args });
  }
  return found;
}

/** The keys of the options object of a `t(key, { ... })` call: written out, shorthand, or `...spread`. */
function optionKeys(call: string): string[] {
  const [, options] = calls(call)[0]?.args ?? [];
  if (!options?.startsWith("{")) return [];
  return parts(options, 1).parts.map((entry) => {
    const key = entry.match(/^(\.\.\.\s*)?["']?([\w$]+)/);
    return key?.[1] ? `...${key[2]}` : (key?.[2] ?? entry);
  });
}

describe("every name the editor's texts take", () => {
  it("is passed with PLAIN", () => {
    const missing: string[] = [];
    for (const root of ROOTS)
      for (const file of sources(path.join(WEB, root)))
        for (const { line, text } of calls(readFileSync(file, "utf8"))) {
          const named = optionKeys(text).filter((k) => !NUMBER_PARAMS.has(k) && k !== "...PLAIN");
          const plain = text.includes("...PLAIN") || text.includes("escapeValue: false");
          if (named.length && !plain) missing.push(`${path.relative(WEB, file)}:${line} ${named.join(", ")}`);
        }
    expect(missing).toEqual([]);
  });

  it("finds the options of a call", () => {
    expect(optionKeys(`t("a", { name: style.name, n: f(1, 2), ...PLAIN })`)).toEqual([
      "name",
      "n",
      "...PLAIN",
    ]);
    expect(optionKeys(`t("a", { label })`)).toEqual(["label"]);
    expect(optionKeys(`t("a")`)).toEqual([]);
    expect(calls(`x(t("a", { q: "(" }), t("b"))`).map((c) => c.text)).toEqual([
      `t("a", { q: "(" })`,
      `t("b")`,
    ]);
  });
});
