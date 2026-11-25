import { type Page, expect, test } from "@playwright/test";

import { datasetOf } from "../fixtures/datasets";
import { addDatasetsToProject, createProject, deleteProject, projectMap } from "../fixtures/projects";
import { apiAs, needsAuth } from "../fixtures/users";

/**
 * The style panel on the project page (GOAT Style): a change is saved to the
 * layer's active style on its own, and is there after a reload, on the map
 * request and in the panel.
 */
needsAuth(test);
test.describe.configure({ mode: "serial", retries: 0 });

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

/** The one layer's active style, as the map request answers it. */
const activeDocument = async () => {
  const api = await apiAs("owner");
  try {
    const { styles } = await projectMap(api, projectId);
    return Object.values(styles)[0]?.active.document;
  } finally {
    await api.dispose();
  }
};

const openStylePanel = async (page: Page) => {
  await page.goto(`/map/${projectId}`);
  const row = page.locator(".tree-item").filter({ hasText: "E2E Points" });
  await row.getByText("E2E Points", { exact: true }).click({ timeout: 30000 });
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
