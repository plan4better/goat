// The legend gallery: every legend case drawn by the app's own legend component, on one page for looking at.
// Not a check: it runs only when asked, and writes the page to the path given.
//
//   LEGEND_GALLERY=/path/to/legend-gallery.html pnpm vitest run lib/style/__tests__/legend/gallery.test.tsx
import { ThemeProvider } from "@mui/material/styles";
import { render } from "@testing-library/react";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { buildLegend } from "@/lib/style/legend";

import { StyleLegend } from "@/components/map/legend/StyleLegend";

import { assess } from "./assess";
import { type LegendCase, legendCases } from "./cases";
import { KNOWN_DIFFERENCES, known } from "./known";

vi.mock("react-i18next", async () => (await import("./i18n")).reactI18nextMock);

// Asked for by hand only: no build or cached task reads it.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const OUT = process.env.LEGEND_GALLERY;
const PUBLIC = resolve(__dirname, "../../../../public");

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Icons the legend loads from the app's own files, written into the page: it has no server to ask. */
function inlineIcons(html: string): string {
  return html.replace(/\/assets\/icons\/[a-z0-9/_-]+\.svg/g, (path) => {
    const file = resolve(PUBLIC, `.${path}`);
    if (!existsSync(file)) return path;
    return `data:image/svg+xml;base64,${readFileSync(file).toString("base64")}`;
  });
}

const QUIET = new Set(["no", "none", "fixed", "normal"]);
const LABELS: Record<string, string> = {
  point_circle: "Point, circle",
  point_pin: "Point, pin with icon",
  point_icon: "Point, icon",
  line: "Line",
  polygon: "Polygon",
  polygon_raised: "Polygon, raised (3D)",
};

function group(c: LegendCase): string {
  if (!c.geometry) return "raster";
  return c.geometry;
}

function describe(c: LegendCase): { title: string; chips: string[] } {
  if (!c.values) {
    const render = (c.style.render as { type?: string } | undefined)?.type;
    return {
      title: `Spec example, line ${c.id.slice(5)}`,
      chips: [c.geometry ?? "raster", ...(render ? [render] : [])],
    };
  }
  const v = c.values;
  const classified =
    v.method === "none"
      ? "no classification"
      : `${v.target.replace("_", " ")} by ${v.method.replace("_", " ")}`;
  const chips = Object.entries(v)
    .filter(([name, value]) => !["geometry", "method", "target", "zoom"].includes(name) && !QUIET.has(value))
    .map(([name, value]) =>
      value === "yes" ? name.replace(/_/g, " ") : `${name.replace(/_/g, " ")}: ${value.replace(/_/g, " ")}`
    );
  return { title: `${LABELS[v.geometry]} · ${classified}`, chips };
}

it.skipIf(!OUT)("writes the gallery page", () => {
  const themes = {
    light: createAppTheme({ mode: "light", locale: "en" }),
    dark: createAppTheme({ mode: "dark", locale: "en" }),
  };
  const cards: string[] = [];
  const counts = { change: 0, question: 0, bug: 0 };
  const topics = new Map<string, { kind: string; text: string; count: number }>();
  for (const c of legendCases()) {
    const legend = buildLegend(c.style, {
      geometry: c.geometry,
      zoom: c.zoom,
      serviceLegendUrl: c.serviceLegendUrl,
    });
    const drawn = (["light", "dark"] as const).map((mode) => {
      const theme = themes[mode];
      const { container, unmount } = render(
        <ThemeProvider theme={theme}>
          {legend ? <StyleLegend legend={legend} layerName="Layer name" locale="en" /> : null}
        </ThemeProvider>
      );
      const html = legend ? container.innerHTML : `<p class="none">No legend for this layer</p>`;
      unmount();
      return `<div class="lg lg-${mode}" style="background:${theme.palette.background.paper};color:${theme.palette.text.primary}">${html}</div>`;
    });
    const { title, chips } = describe(c);
    const broken = known("compiles", c);
    const remarks = [
      ...(broken
        ? [{ kind: "bug" as const, text: `The map rejects this layer today. ${broken.reason}` }]
        : []),
      ...assess(c, legend),
    ];
    for (const r of remarks) if (r.kind !== "fine") counts[r.kind]++;
    for (const r of remarks)
      if ("topic" in r)
        topics.set(r.topic, {
          kind: r.kind,
          text: topics.get(r.topic)?.text ?? r.text,
          count: (topics.get(r.topic)?.count ?? 0) + 1,
        });
    const flags = [...new Set(remarks.map((r) => r.kind))].join(" ");
    cards.push(
      `<article class="card" data-group="${group(c)}" data-source="${c.values ? "generated" : "spec"}" data-flags="${flags}">` +
        `<header><span class="id">${c.id}</span><h3>${escape(title)}</h3></header>` +
        `<p class="chips">${[...chips, `zoom ${c.zoom}`].map((chip) => `<span>${escape(chip)}</span>`).join("")}</p>` +
        drawn.join("") +
        (remarks.length
          ? `<ul class="remarks">${remarks.map((r) => `<li class="${r.kind}"><b>${r.kind === "change" ? "Change" : r.kind === "question" ? "Decide" : r.kind === "bug" ? "Bug" : "Fine"}</b> ${escape(r.text)}</li>`).join("")}</ul>`
          : "") +
        `<details><summary>Style</summary><pre>${escape(JSON.stringify(c.style, null, 1))}</pre></details>` +
        `</article>`
    );
  }
  const css = [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
  const shell = readFileSync(resolve(__dirname, "gallery.html"), "utf8");
  const page = shell
    .replace("/*LEGEND_CSS*/", () => css)
    .replace("<!--CARDS-->", () => inlineIcons(cards.join("\n")))
    .replace("<!--COUNT-->", () => String(cards.length))
    .replace("<!--CHANGES-->", () => String([...topics.values()].filter((t) => t.kind === "change").length))
    .replace("<!--QUESTIONS-->", () =>
      String([...topics.values()].filter((t) => t.kind === "question").length)
    )
    .replace("<!--BUGS-->", () => String(counts.bug))
    .replace(
      "<!--SUMMARY-->",
      () =>
        [...topics.values()]
          .sort((a, b) => a.kind.localeCompare(b.kind) || b.count - a.count)
          .map(
            (t) =>
              `<li class="${t.kind}"><b>${t.kind === "change" ? "Change" : t.kind === "question" ? "Decide" : "Fine"}</b> ${escape(t.text)} <span class="n">${t.count} ${t.count === 1 ? "case" : "cases"}</span></li>`
          )
          .join("\n") +
        KNOWN_DIFFERENCES.filter((k) => k.check === "compiles")
          .map((k) => `<li class="bug"><b>Bug</b> The map rejects the layer. ${escape(k.reason)}</li>`)
          .join("\n")
    );
  writeFileSync(OUT as string, page);
});
