import { expect, test } from "@playwright/test";

import { datasetOf, rowCount } from "../fixtures/datasets";
import { addDatasetsToProject, createProject, deleteProject } from "../fixtures/projects";
import { apiAs, needsAuth } from "../fixtures/users";

/**
 * Editing features on the map: a point added by clicking the map is saved
 * to the dataset. Works on its own copy of the points, so the other specs
 * keep their count.
 */
needsAuth(test);

let projectId: string;

test.beforeAll(async () => {
  const api = await apiAs("owner");
  try {
    projectId = await createProject(api, `E2E Edit ${Date.now()}`);
    await addDatasetsToProject(api, projectId, [datasetOf("editable")]);
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

test("a point added on the map is saved to the dataset", async ({ page }) => {
  const api = await apiAs("owner");
  try {
    const before = await rowCount(api, datasetOf("editable"));

    await page.goto(`/map/${projectId}`);
    const row = page.locator(".tree-item").filter({ hasText: "E2E Editable Points" });
    await row.getByRole("button", { name: "More options" }).click({ timeout: 30000 });
    await page.getByRole("button", { name: "Edit features", exact: true }).click();

    await page.getByRole("button", { name: "Add a feature" }).click();
    // The middle of the map, clear of the layer tree and the toolbar.
    const canvas = page.locator(".maplibregl-canvas");
    const box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: box.width * 0.6, y: box.height * 0.4 } });

    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Features saved")).toBeVisible({ timeout: 30000 });

    await expect.poll(() => rowCount(api, datasetOf("editable")), { timeout: 15000 }).toBe(before + 1);
  } finally {
    await api.dispose();
  }
});
