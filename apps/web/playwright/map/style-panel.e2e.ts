import { type Locator, type Page, type Response, expect, test } from "@playwright/test";

import { datasetOf } from "../fixtures/datasets";
import { addDatasetsToProject, createProject, deleteProject, projectMap } from "../fixtures/projects";
import { apiAs, needsAuth } from "../fixtures/users";

/**
 * The style panel on the project page (GOAT Style): a change is saved to the
 * layer's active style on its own, and is there after a reload, on the map
 * request and in the panel. On the points layer: the color picker's
 * transparency bar dragged in a real browser, None, Auto, and the colors an
 * outline and a label start with when switched on.
 */
needsAuth(test);
// One worker, in order; a failing test does not skip the others (each uses a project of its own).
test.describe.configure({ mode: "default", retries: 0 });

let projectId: string;

test.beforeAll(async () => {
  const api = await apiAs("owner");
  try {
    projectId = await createProject(api, `E2E Style Panel ${Date.now()}`);
    await addDatasetsToProject(api, projectId, [datasetOf("points")]);
  } finally {
    await api.dispose();
  }
});

test.afterAll(async () => {
  const api = await apiAs("owner");
  try {
    await deleteProject(api, projectId);
  } finally {
    await api.dispose();
  }
});

/** The active style of a project's one layer, as the map request answers it. */
const activeDocument = async (project = projectId) => {
  const api = await apiAs("owner");
  try {
    const { styles } = await projectMap(api, project);
    return Object.values(styles)[0]?.active.document;
  } finally {
    await api.dispose();
  }
};

const openStylePanel = async (page: Page, project = projectId, layerName = "E2E Points") => {
  await page.goto(`/map/${project}`);
  const row = page.locator(".tree-item").filter({ hasText: layerName });
  await row.getByText(layerName, { exact: true }).click({ timeout: 30000 });
  const panel = page.locator("[data-style-panel]");
  await expect(panel).toBeVisible();
  return panel;
};

test("a colour changed in the style panel is saved, and is there after a reload", async ({ page }) => {
  const panel = await openStylePanel(page);
  // Points: the Fill row (the first with a colour value) holds the marker's colour.
  await panel
    .getByRole("button", { name: /#[0-9a-f]{6}/i })
    .first()
    .click();
  const saved = page.waitForResponse(
    (r) => /\/layer\/\d+\/style\//.test(r.url()) && r.request().method() === "PUT" && r.ok()
  );
  // The editor's Color field opens the color picker, which takes the typed color.
  await page.getByRole("button", { name: "Pick a color" }).first().click();
  await page.getByLabel("Color value").fill("#ff0000");
  await saved;
  // The save status sits in the panel's header, beside the style picker: once saved, a check named "Saved".
  await expect(page.getByRole("status", { name: "Saved" })).toBeVisible();
  await expect.poll(activeDocument).toMatchObject({ symbol: { marker: { color: "#ff0000" } } });

  const reopened = await openStylePanel(page);
  await reopened
    .getByRole("button", { name: /#[0-9a-f]{6}/i })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "Pick a color" }).first()).toHaveText("#FF0000");
});

test.describe("colors of the points layer", () => {
  let project: string | undefined;

  // Each test styles a layer of its own: a new project's layer starts from the dataset's style.
  test.beforeEach(async () => {
    project = undefined;
    const api = await apiAs("owner");
    try {
      project = await createProject(api, `E2E Style Panel Colors ${Date.now()}`);
      await addDatasetsToProject(api, project, [datasetOf("points")]);
    } finally {
      await api.dispose();
    }
  });

  test.afterEach(async () => {
    const api = await apiAs("owner");
    try {
      await deleteProject(api, project);
    } finally {
      await api.dispose();
    }
  });

  /** The parts of the layer's stored symbol the tests read; a part switched off holds `false`. */
  type StoredSymbol = {
    marker?: { color?: string };
    outline?: { color?: string; width?: number };
    label?: { color?: string };
  };
  const symbolOf = async () => (await activeDocument(project!))?.symbol as StoredSymbol | undefined;

  /** The value field of the panel's row with this label ("Fill", "Outline", "Label"): it opens the part's editor. */
  const rowField = (panel: Locator, label: string) =>
    panel.getByText(label, { exact: true }).locator("..").getByRole("button").first();
  /** The part editor the panel opened (the first level of its popovers). */
  const editorOf = (page: Page) => page.locator('[data-popover-frame][data-popover-level="1"]');
  /** The color picker: the popover that holds the color's text field. */
  const pickerOf = (page: Page) =>
    page.locator("[data-popover-frame]").filter({ has: page.getByLabel("Color value", { exact: true }) });
  /** A choice in front of the picker's swatches ("Auto", "None"). */
  const choice = (page: Page, name: string) => pickerOf(page).getByRole("button", { name, exact: true });
  /** A GOAT color that no seeded layer color is. */
  const SWATCH = "#1A6B4D";
  const PUT_STYLE = (r: Response) =>
    /\/layer\/\d+\/style\//.test(r.url()) && r.request().method() === "PUT" && r.ok();

  test("dragging a color's transparency bar saves an eight-digit color, and None sets it to 0 %", async ({
    page,
  }) => {
    // The test fails on an error of the page's code and on React's update loop; any other console error (a stack
    // that logs failed tiles) is attached to the result, not a failure.
    const failures: string[] = [];
    const otherErrors: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      (/Maximum update depth/.test(message.text()) ? failures : otherErrors).push(message.text());
    });

    const panel = await openStylePanel(page, project);
    // Points: the Fill row holds the marker's color.
    await rowField(panel, "Fill").click();
    await editorOf(page).getByRole("button", { name: "Pick a color" }).click();
    const picker = pickerOf(page);
    const percent = picker.getByRole("textbox", {
      name: "Transparency of this color in percent",
      exact: true,
    });
    await expect(percent).toHaveValue("100");

    // The bar's box (MUI's slider root: the range input sits in its thumb), dragged from near its opaque end to about
    // 40 % in many small moves, as a hand does.
    const thumb = picker
      .getByRole("slider", { name: "Transparency of this color", exact: true })
      .locator("..");
    // The picker scrolls inside its popover on a short window.
    await thumb.scrollIntoViewIfNeeded();
    const box = await thumb.locator("..").boundingBox();
    expect(box, "the transparency bar's box").toBeTruthy();
    const y = box!.y + box!.height / 2;
    const from = box!.x + box!.width * 0.95;
    const to = box!.x + box!.width * 0.4;
    const saved = page.waitForResponse(PUT_STYLE);
    await page.mouse.move(from, y);
    await page.mouse.down();
    const steps = 60;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(from + ((to - from) * i) / steps, y);
      // A hand moves over time: the page renders between two moves.
      // eslint-disable-next-line playwright/no-wait-for-timeout
      await page.waitForTimeout(5);
    }
    await page.mouse.up();
    await saved;
    await expect(page.getByRole("status", { name: "Saved" })).toBeVisible();

    test
      .info()
      .annotations.push({ type: "other console errors", description: otherErrors.join("\n") || "none" });
    expect(failures, `other console errors:\n${otherErrors.join("\n")}`).toEqual([]);
    // The page did not crash: the panel and the picker are still there.
    await expect(panel).toBeVisible();
    await expect(picker).toBeVisible();
    const shown = Number(await percent.inputValue());
    expect(shown).toBeGreaterThanOrEqual(25);
    expect(shown).toBeLessThanOrEqual(55);
    // The stored color carries its transparency in eight digits, at the percent the field shows.
    await expect
      .poll(async () => {
        const color = (await symbolOf())?.marker?.color;
        return typeof color === "string" && /^#[0-9a-f]{8}$/i.test(color)
          ? Math.round((parseInt(color.slice(7), 16) / 255) * 100)
          : color;
      })
      .toBe(shown);

    await choice(page, "None").click();
    await expect(choice(page, "None")).toHaveAttribute("aria-pressed", "true");
    await expect(percent).toHaveValue("0");
    await expect(editorOf(page).getByRole("button", { name: "Pick a color" })).toHaveText("None");
    await expect.poll(async () => (await symbolOf())?.marker?.color).toMatch(/^#[0-9a-f]{6}00$/i);
    expect(failures, `other console errors:\n${otherErrors.join("\n")}`).toEqual([]);
  });

  test("Auto on the outline's color is saved, after a fixed color too", async ({ page }) => {
    // Written from the layer's stored outline: absent or off, the switch turns it on and it starts with Auto; on,
    // its color is set to Auto in the picker.
    const start = (await symbolOf())?.outline;
    const panel = await openStylePanel(page, project);
    await rowField(panel, "Outline").click();
    const editor = editorOf(page);
    // The seeded layer's stored state decides which of the two ways reaches Auto.
    // eslint-disable-next-line playwright/no-conditional-in-test
    if (!start) {
      await editor.getByRole("checkbox", { name: "Turn outline on", exact: true }).click();
      // The row starts with the Auto choice and its width; the button may hold more than the summary.
      await expect(rowField(panel, "Outline")).toHaveText(/^Auto · .*1 px/);
      await expect.poll(async () => (await symbolOf())?.outline).toEqual({ color: "auto", width: 1 });
      await editor.getByRole("button", { name: "Pick a color" }).click();
      await expect(choice(page, "Auto")).toHaveAttribute("aria-pressed", "true");
    } else {
      await editor.getByRole("button", { name: "Pick a color" }).click();
      await choice(page, "Auto").click();
      await expect(choice(page, "Auto")).toHaveAttribute("aria-pressed", "true");
      await expect.poll(async () => (await symbolOf())?.outline?.color).toBe("auto");
    }
    await expect(editor.getByRole("button", { name: "Pick a color" })).toHaveText("Auto");
    await expect(rowField(panel, "Outline")).toHaveText(/^Auto · /);

    await pickerOf(page).getByRole("button", { name: SWATCH, exact: true }).first().click();
    await expect(choice(page, "Auto")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => (await symbolOf())?.outline?.color).toBe(SWATCH.toLowerCase());

    await choice(page, "Auto").click();
    await expect(choice(page, "Auto")).toHaveAttribute("aria-pressed", "true");
    await expect(rowField(panel, "Outline")).toHaveText(/^Auto · /);
    await expect.poll(async () => (await symbolOf())?.outline?.color).toBe("auto");
  });

  test("a label switched on starts with Auto text and halo, and off and on again brings back its text color", async ({
    page,
  }) => {
    const panel = await openStylePanel(page, project);
    await rowField(panel, "Label").click();
    const editor = editorOf(page);
    await editor.getByRole("checkbox", { name: "Turn label on", exact: true }).click();
    await expect
      .poll(async () => (await symbolOf())?.label)
      .toEqual({ color: "auto", halo: { color: "auto" } });

    // The text's color (the Halo has its own popover): a GOAT color.
    await editor.getByRole("button", { name: "Pick a color" }).click();
    await expect(choice(page, "Auto")).toHaveAttribute("aria-pressed", "true");
    await pickerOf(page).getByRole("button", { name: SWATCH, exact: true }).first().click();
    await expect.poll(async () => (await symbolOf())?.label?.color).toBe(SWATCH.toLowerCase());
    // Escape closes the picker, the label's editor stays open.
    await page.keyboard.press("Escape");
    await expect(pickerOf(page)).toHaveCount(0);

    await editor.getByRole("checkbox", { name: "Turn label off", exact: true }).click();
    await expect.poll(async () => (await symbolOf())?.label).toBe(false);
    await editor.getByRole("checkbox", { name: "Turn label on", exact: true }).click();
    await expect
      .poll(async () => (await symbolOf())?.label)
      .toEqual({ color: SWATCH.toLowerCase(), halo: { color: "auto" } });
  });
});
