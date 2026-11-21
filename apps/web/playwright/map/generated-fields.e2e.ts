import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

import { GEOAPI_URL, POINTS_FILE, deleteDataset, uploadDataset } from "../fixtures/datasets";
import { addDatasetsToProject, createProject, deleteProject, projectLayers } from "../fixtures/projects";
import { apiAs, needsAuth } from "../fixtures/users";

/**
 * Generated fields: a "Serial" (running number) and a "UUID" column are
 * filled by GOAT when a feature is created, never by the user.
 *
 * A layer declared with both in the Create layer dialog numbers the points
 * drawn into it 1, 2, 3 and gives each its own UUID, while the attribute
 * form shows both as read-only, "Assigned automatically". A serial column
 * added to a layer that already has rows numbers them once, 1 to n.
 *
 * Works on its own layers (created and uploaded here, then trashed), so the
 * provisioned datasets keep their columns.
 */
needsAuth(test);
// Creating and importing layers are jobs.
test.describe.configure({ mode: "serial", timeout: 240000 });
test.use({ actionTimeout: 60000 });

const term = `e2egen${Date.now()}`;
const createdName = `${term} Generated`;
const uploadedName = `${term} Existing`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The suite's points file holds 26 features. */
const UPLOADED_ROWS = 26;

let projectId: string;
let uploadedId: string | undefined;
let createdId: string | undefined;

/** Every row's properties, as geoapi serves them. */
const rows = async (api: APIRequestContext, layerId: string): Promise<Record<string, unknown>[]> => {
  const response = await api.get(`${GEOAPI_URL}/collections/${layerId}/items`, { params: { limit: 1000 } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { features: { properties: Record<string, unknown> }[] }).features.map(
    (feature) => feature.properties
  );
};

const layerMenu = async (page: Page, layerName: string) => {
  const row = page.locator(".tree-item").filter({ hasText: layerName });
  await row.getByRole("button", { name: "More options" }).click({ timeout: 30000 });
};

/** Adds a field in the field editor (Create layer's or Edit fields'). */
const addField = async (page: Page, dialog: ReturnType<Page["getByRole"]>, name: string, kind: string) => {
  await dialog.getByRole("button", { name: "Add field" }).click();
  await dialog.getByPlaceholder("Field name").last().fill(name);
  await dialog.getByRole("combobox", { name: "Field type" }).click();
  await page.getByRole("option", { name: kind }).click();
};

test.beforeAll(async () => {
  test.setTimeout(300000);
  const api = await apiAs("owner");
  try {
    projectId = await createProject(api, `${term} project`);
    uploadedId = await uploadDataset(api, uploadedName, POINTS_FILE);
    await addDatasetsToProject(api, projectId, [uploadedId]);
  } finally {
    await api.dispose();
  }
});

test.afterAll(async () => {
  const api = await apiAs("owner");
  try {
    // By name too: a layer created in a test that failed left no id.
    if (!createdId) {
      const layers = await projectLayers(api, projectId).catch(
        () => [] as { name: string; layer_id: string }[]
      );
      createdId = layers.find((layer) => layer.name === createdName)?.layer_id;
    }
    await deleteProject(api, projectId);
    await deleteDataset(api, createdId);
    await deleteDataset(api, uploadedId);
  } finally {
    await api.dispose();
  }
});

test("a layer created with a serial and a UUID field numbers and identifies the features drawn into it", async ({
  page,
}) => {
  await page.goto(`/map/${projectId}`);
  await page.getByRole("button", { name: "Add layer" }).click({ timeout: 30000 });
  await page.getByRole("menuitem", { name: "Create layer" }).click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Create layer" });
  await expect(dialog).toBeVisible();
  await dialog.locator("input[name=name]").fill(createdName);
  await dialog.getByRole("button", { name: "Point", exact: true }).click();

  await addField(page, dialog, "nr", "Serial");
  // A serial says what it does and where it starts.
  await expect(
    dialog.getByText("Numbered automatically: every new feature gets the next number")
  ).toBeVisible();
  await dialog.getByTestId("serial-start").fill("1");
  await addField(page, dialog, "uid", "UUID");
  await expect(dialog.getByText("Every feature gets its own unique identifier automatically")).toBeVisible();

  await dialog.getByRole("button", { name: "Create layer", exact: true }).click();
  await expect(page.locator(".tree-item").filter({ hasText: createdName })).toBeVisible({ timeout: 120000 });

  const api = await apiAs("owner");
  try {
    createdId = (await projectLayers(api, projectId)).find((layer) => layer.name === createdName)?.layer_id;
    expect(createdId, "the created layer in the project").toBeTruthy();

    // Three points, one at a time. The attribute form shows both generated
    // fields read-only, with no value until the feature is saved.
    await layerMenu(page, createdName);
    await page.getByRole("button", { name: "Edit features", exact: true }).click();
    const canvas = page.locator(".maplibregl-canvas");
    const box = (await canvas.boundingBox())!;
    for (const [x, y] of [
      [0.55, 0.35],
      [0.6, 0.45],
      [0.65, 0.55],
    ]) {
      await page.getByRole("button", { name: "Add a feature" }).click();
      await canvas.click({ position: { x: box.width * x, y: box.height * y } });
      // The "Feature attributes" panel.
      const generated = page.getByPlaceholder("Assigned automatically");
      await expect(generated).toHaveCount(2);
      for (const input of await generated.all()) await expect(input).toBeDisabled();
      await page.getByRole("button", { name: "Done", exact: true }).click();
    }
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Features saved")).toBeVisible({ timeout: 30000 });

    // The numbers 1, 2 and 3, and three distinct UUIDs.
    let saved: Record<string, unknown>[] = [];
    await expect
      .poll(
        async () => {
          saved = await rows(api, createdId!);
          return saved.length;
        },
        { timeout: 30000 }
      )
      .toBe(3);
    expect(saved.map((row) => Number(row.nr)).sort()).toEqual([1, 2, 3]);
    const uids = saved.map((row) => String(row.uid));
    for (const uid of uids) expect(uid).toMatch(UUID_PATTERN);
    expect(new Set(uids).size).toBe(3);
  } finally {
    await api.dispose();
  }
});

test("a serial field added to a layer with rows numbers them once, 1 to n", async ({ page }) => {
  await page.goto(`/map/${projectId}`);
  await layerMenu(page, uploadedName);
  await page.getByRole("button", { name: "View Data", exact: true }).click();
  await page.getByRole("button", { name: "Edit fields", exact: true }).click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Edit fields" });
  await expect(dialog).toBeVisible();
  await addField(page, dialog, "seq", "Serial");
  await expect(dialog.getByText(/Features already in the layer are numbered from here/)).toBeVisible();
  await dialog.getByTestId("serial-start").fill("1");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Fields saved")).toBeVisible({ timeout: 30000 });

  const api = await apiAs("owner");
  try {
    let existing: Record<string, unknown>[] = [];
    await expect
      .poll(
        async () => {
          existing = await rows(api, uploadedId!);
          return existing.every((row) => row.seq !== null && row.seq !== undefined);
        },
        { timeout: 30000 }
      )
      .toBe(true);
    expect(existing).toHaveLength(UPLOADED_ROWS);
    expect(existing.map((row) => Number(row.seq)).sort((a, b) => a - b)).toEqual(
      Array.from({ length: UPLOADED_ROWS }, (_, index) => index + 1)
    );
  } finally {
    await api.dispose();
  }
});
