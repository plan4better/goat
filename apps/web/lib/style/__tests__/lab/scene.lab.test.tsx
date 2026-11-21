import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@/lib/style/json";

import {
  LAB_FONT,
  type LabCase,
  type Scene,
  brokenPictures,
  closeScene,
  markerIconFailures,
  queueUnmount,
  renderScene,
} from "./scene";

const scenes: Scene[] = [];

// Each test reads the requests of its own scene, and the browser's list of them never fills up.
beforeEach(() => performance.clearResourceTimings());

afterEach(() => {
  while (scenes.length) closeScene(scenes.pop()!);
});

async function scene(c: LabCase): Promise<Scene> {
  const drawn = await renderScene(c);
  scenes.push(drawn);
  return drawn;
}

/** Two categories of `category` and features without a value, each in its own color. */
const CATEGORIES: JsonObject = {
  version: "1.0.0",
  kind: "vector",
  symbol: { marker: { shape: "circle", color: "#888888", size: 16 } },
  classify: [
    {
      id: "kind",
      field: "category",
      method: "categories",
      classes: [
        { values: ["a"], marker: { color: "#1b9e77" }, name: "A" },
        { values: ["b"], marker: { color: "#d95f02" }, name: "B" },
      ],
      no_data: { marker: { color: "#7570b3" } },
      computed: { no_data: true, other: false },
    },
  ],
};

/** Where the app loads the uploaded icon `asset:lab-icon` from, with the lab's API (vitest.lab.config.ts). */
const UPLOAD_PATH = "/lab-api/api/v2/asset/lab-icon/file";

const point = (id: string, style: JsonObject): LabCase => ({
  id,
  style,
  geometry: "point",
  zoom: 4,
  fields: { category: "string" },
});

describe("the lab scene", () => {
  it("a categories case places one feature per entry at its pixel", async () => {
    const s = await scene(point("categories", CATEGORIES));

    expect(s.errors).toEqual([]);
    expect(s.placed.map((p) => `${p.section}/${p.entry.id}`)).toEqual(["kind/0", "kind/1", "kind/no_data"]);
    for (const p of s.placed) {
      const found = s.map.queryRenderedFeatures(p.pixel).map((f) => f.id);
      expect(found, `${p.section}/${p.entry.id} at ${p.pixel}`).toContain(p.featureId);
    }
    // The legend is drawn beside the map, with the app's words.
    expect(s.root.textContent).toContain("A");
    expect(s.root.textContent).toContain("No data");
  });

  it("the legend's text is drawn in the app's font, loaded from the repo's files", async () => {
    const s = await scene(point("font", CATEGORIES));

    expect(s.errors).toEqual([]);
    const text = [...s.root.querySelectorAll("[data-lab-legend] *")].find((el) => el.textContent === "A");
    expect(text).toBeDefined();
    expect(getComputedStyle(text!).fontFamily).toBe(LAB_FONT);
    const faces = [...document.fonts].filter((face) => face.family.replace(/"/g, "") === LAB_FONT);
    expect(faces.filter((face) => face.style === "normal").map((face) => [face.weight, face.status])).toEqual(
      ["300", "400", "500", "600", "700"].map((weight) => [weight, "loaded"])
    );
  });

  it("a scene drawn right after another one is closed is drawn", async () => {
    closeScene(await renderScene(point("first", CATEGORIES)));
    const s = await scene(point("second", CATEGORIES));

    expect(s.errors).toEqual([]);
    expect(s.placed.length).toBe(3);
  });

  it("a scene drawn right after two others are closed is drawn", async () => {
    const first = await renderScene(point("first", CATEGORIES));
    const second = await renderScene(point("second", CATEGORIES));
    closeScene(first);
    closeScene(second);
    const s = await scene(point("third", CATEGORIES));

    expect(s.errors).toEqual([]);
    expect(s.placed.length).toBe(3);
  });

  it("a legend that fails to come off the page is the next scene's error, and that scene is drawn", async () => {
    queueUnmount(() => Promise.reject(new Error("lab: unmount failed")));
    const s = await scene(point("after-failure", CATEGORIES));

    expect(s.errors).toEqual([
      "scene: the last scene's legend did not come off the page: lab: unmount failed",
    ]);
    expect(s.placed.length).toBe(3);
  });

  it("map errors and console errors land in `errors`", async () => {
    const s = await scene(point("errors", CATEGORIES));
    expect(s.errors).toEqual([]);

    s.map.addLayer({
      id: "bad",
      type: "circle",
      source: Object.keys(s.map.getStyle().sources)[0],
      paint: { "circle-color": "not a color" },
    });
    console.error("lab: something broke");

    expect(s.errors.some((e) => e.includes("circle-color"))).toBe(true);
    expect(s.errors).toContain("console: lab: something broke");
  });

  it("a rule's entry samples that rule, also after a rule the legend leaves out", async () => {
    const when = (value: string) => ({ op: "=", args: [{ property: "category" }, value] });
    const s = await scene(
      point("rules", {
        version: "1.0.0",
        kind: "vector",
        symbol: { marker: { shape: "circle", color: "#888888", size: 16 } },
        rules: [
          { name: "Hidden", legend: false, when: when("a"), marker: { color: "#ff0000" } },
          { name: "B", when: when("b"), marker: { color: "#0000ff" } },
        ],
      })
    );

    expect(s.errors).toEqual([]);
    const rule = s.placed.find((p) => p.section === "rules" && p.entry.name === "B");
    expect(rule).toBeDefined();
    const feature = s.map.queryRenderedFeatures(rule!.pixel).find((f) => f.id === rule!.featureId);
    expect(feature?.properties.category).toBe("b");
  });

  it("an uploaded icon draws through the app's upload route, on the map and in the legend", async () => {
    const s = await scene(
      point("upload", {
        version: "1.0.0",
        kind: "vector",
        symbol: { marker: { shape: "icon", icon: "asset:lab-icon", size: 24 } },
      })
    );

    expect(s.errors).toEqual([]);
    expect(s.requestedImages).toContain("asset:lab-icon");
    expect(s.map.hasImage("asset:lab-icon")).toBe(true);
    expect(s.placed).toHaveLength(1);
    const [p] = s.placed;
    expect(s.map.queryRenderedFeatures(p.pixel).map((f) => f.id)).toContain(p.featureId);
    // The legend shows the same picture, loaded.
    const img = s.root.querySelector<HTMLImageElement>(`img[src$="${UPLOAD_PATH}"]`);
    expect(img).not.toBeNull();
    expect(img!.complete && img!.naturalWidth > 0).toBe(true);
    // Every request the page made stayed on the lab's own server, the icon's among them.
    const requested = performance.getEntriesByType("resource").map((e) => e.name);
    expect(requested.filter((url) => new URL(url).origin !== location.origin)).toEqual([]);
    expect(requested.some((url) => new URL(url).pathname === UPLOAD_PATH)).toBe(true);
  });

  it("a legend icon that does not load is reported", async () => {
    const s = await scene(
      point("library", {
        version: "1.0.0",
        kind: "vector",
        symbol: { marker: { shape: "pin", icon: "goat:park", size: 24 } },
      })
    );
    expect(s.errors).toEqual([]);
    expect(s.root.querySelector("[data-marker-icon]")).not.toBeNull();

    // Every library icon is among the app's files, so the failing one is put into the legend by hand.
    const broken = document.createElement("span");
    broken.setAttribute("data-marker-icon", "/lab/nothing.svg");
    s.root.append(broken);
    expect(await markerIconFailures(s.root)).toEqual(["legend icon failed to load: /lab/nothing.svg"]);
  });

  it("a legend picture the browser cannot show is reported, also when its request succeeds", async () => {
    const s = await scene(point("picture", CATEGORIES));
    expect(s.errors).toEqual([]);
    expect(brokenPictures(s.root)).toEqual([]);

    // A fixture that answers 200 with bytes that are no picture.
    const picture = document.createElement("img");
    const done = new Promise((resolve) => {
      picture.addEventListener("load", resolve, { once: true });
      picture.addEventListener("error", resolve, { once: true });
    });
    picture.src = "/lab/h3/facts.json";
    s.root.append(picture);
    await done;
    expect(brokenPictures(s.root)).toEqual([
      expect.stringMatching(/^img failed to load: .*\/lab\/h3\/facts\.json$/),
    ]);
  });

  it("requests that fail, leave the lab's server or get no answer land in `errors`", async () => {
    const s = await scene(point("requests", CATEGORIES));
    expect(s.errors).toEqual([]);

    await fetch("/lab/nothing.svg");
    await fetch("https://example.com/", { mode: "no-cors" }).catch(() => undefined);
    await fetch("/lab-hang-up").catch(() => undefined);

    await expect
      .poll(() => s.errors)
      .toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^request failed \(404\): .*\/lab\/nothing\.svg$/),
          "request to another host: https://example.com/",
          expect.stringMatching(/^request got no response: .*\/lab-hang-up$/),
        ])
      );
  });
});
