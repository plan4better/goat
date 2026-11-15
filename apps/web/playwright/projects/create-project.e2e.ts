import { expect, test } from "@playwright/test";

import { deleteContentItem } from "../fixtures/content";

test.describe("Project Management", () => {
  test("create a new project from home page", async ({ page }) => {
    await page.goto("/home");

    // Home's hero "New project" is a menu of the project starts; a blank one
    // opens the same name-only dialog Content's "Add new" uses.
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByRole("menuitem", { name: "Blank project" }).click();

    // Dialog should appear
    await expect(page.getByRole("dialog").getByText("New project", { exact: true })).toBeVisible();

    // Fill in project name. Home has no folder of its own being browsed, so
    // the project files into the caller's personal home folder with no
    // destination field to fill in.
    const projectName = `E2E Test Project ${Date.now()}`;
    const nameField = page.getByRole("textbox", { name: "New project" });
    await nameField.click();
    await nameField.fill(projectName);

    // Submit
    await page.getByRole("button", { name: "Create project" }).click();

    // Should redirect to map view (increase timeout for API call + navigation)
    await expect(page).toHaveURL(/\/map\//, { timeout: 30000 });

    // Map view should load — add layer button visible confirms layer panel loaded
    await expect(page.getByRole("button", { name: "Add layer" })).toBeVisible({ timeout: 15000 });

    await deleteContentItem(page, projectName);
  });

  test("create project from the Content page", async ({ page }) => {
    // The old dedicated /projects page now redirects to /content; project
    // creation lives behind its "Add new" menu instead of a page-level
    // "New project" button.
    await page.goto("/content");
    await expect(page.getByRole("heading", { name: "Content" })).toBeVisible();

    await page.getByRole("button", { name: "Add new" }).click();
    await page.getByRole("menuitem", { name: "Blank project" }).click();
    // One field, one button: the destination is the folder being browsed
    // (My Content's root here), so the dialog only asks for a name.
    await expect(page.getByRole("dialog").getByText("New project", { exact: true })).toBeVisible();

    const projectName = `E2E Project Page ${Date.now()}`;
    await page.getByRole("textbox", { name: "New project" }).fill(projectName);

    await page.getByRole("button", { name: "Create project" }).click();

    // Should redirect to map
    await expect(page).toHaveURL(/\/map\//, { timeout: 30000 });

    await deleteContentItem(page, projectName);
  });
});
