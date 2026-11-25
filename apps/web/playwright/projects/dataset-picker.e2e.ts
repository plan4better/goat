import { expect, test } from "@playwright/test";

import { deleteContentItem } from "../fixtures/content";

/**
 * The "My datasets" shelf inside a project: two of the account's own datasets
 * picked in one visit and added to the layer tree.
 *
 * The account is expected to already hold at least two datasets — this spec
 * picks whatever the personal space lists rather than uploading, because an
 * upload's processing job cannot complete in this environment (see
 * `datasets/upload-spatial.e2e.ts`).
 */
test("adds two datasets from My datasets to a project", async ({ page }) => {
  // A fresh project from Home's hero: "New project" opens a menu of the
  // starts (`NewProjectButton`), and a blank one asks for a name only — Home
  // browses no folder of its own, so the project files into the caller's
  // personal home folder and opens the map.
  await page.goto("/home");
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("menuitem", { name: "Blank project" }).click();
  await expect(page.getByRole("dialog").getByText("New project", { exact: true })).toBeVisible();

  const projectName = `E2E Dataset Picker ${Date.now()}`;
  const nameField = page.getByRole("textbox", { name: "New project" });
  await nameField.click();
  await nameField.fill(projectName);
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page).toHaveURL(/\/map\//, { timeout: 30000 });
  await expect(page.getByRole("button", { name: "Add layer" })).toBeVisible({ timeout: 15000 });

  // `.tree-item` is a row of the project's layer tree (`DraggableTreeView`).
  // A new project has none, which is what makes the count below an assertion
  // about what this test added.
  const treeItems = page.locator(".tree-item");
  await expect(treeItems).toHaveCount(0);

  await page.getByRole("button", { name: "Add layer" }).click();
  await page.getByRole("menuitem", { name: "My datasets" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("My datasets")).toBeVisible();

  // Dataset tiles carry a select circle and folder tiles do not, so the
  // circle is what identifies something pickable. Bundles are excluded:
  // one adds a locked group rather than a layer, and this test is about the
  // plain two-datasets case.
  const cards = dialog
    .locator(".content-card")
    .filter({ has: page.getByRole("checkbox") })
    .filter({ hasNotText: "Bundle" });
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThan(1);

  // A click on the tile is the pick — nothing opens from this shelf.
  await cards.nth(0).click();
  await cards.nth(1).click();
  await expect(dialog.getByText("2 selected")).toBeVisible();

  await dialog.getByRole("button", { name: "Add 2 layers" }).click();

  // The dialog closes on click and the result arrives as a toast.
  await expect(page.getByText("2 layers added to the project")).toBeVisible({ timeout: 30000 });
  await expect(treeItems).toHaveCount(2, { timeout: 30000 });

  await deleteContentItem(page, projectName);
});
