import { expect, test } from "@playwright/test";

import { SHARED_TEAM_NAME, ensureSharedTeam, tryDeleteContentItem } from "../fixtures/content";

test.describe("Content Page Management Operations", () => {
  // Named once per run: the folder and the project both end up at the
  // personal space's root, and `afterEach` disposes of them there.
  const suffix = Date.now();
  const folderName = `E2E Folder ${suffix}`;
  const projectName = `E2E Content Project ${suffix}`;

  test.afterEach(async ({ page }) => {
    // Best-effort, so a test that failed halfway still cleans up whatever it
    // did manage to create. The shared team is deliberately left alone.
    await tryDeleteContentItem(page, projectName);
    await tryDeleteContentItem(page, folderName);
  });

  test("create folder and project, move, share with a team, delete and restore", async ({ page }) => {
    // The team whose space the project gets shared with, so the Share
    // dialog's Teams tab has a real row to pick from.
    await ensureSharedTeam(page);

    // Create a folder via Add new -> New folder, at the personal space root.
    // The dialog is one field and one button — its title names what is
    // being created and its input carries that title as a label. The title
    // is plain text, not a heading, so it is found inside the dialog.
    await page.goto("/content");
    await expect(page.getByRole("heading", { name: "Content" })).toBeVisible();
    await page.getByRole("button", { name: "Add new" }).click();
    await page.getByRole("menuitem", { name: "New folder" }).click();
    const folderDialog = page.getByRole("dialog").filter({ hasText: "New folder" });
    await expect(folderDialog.getByText("New folder", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "New folder" }).fill(folderName);
    await page.getByRole("button", { name: "Create folder" }).click();
    await expect(folderDialog).toBeHidden();
    await expect(page.getByText(folderName)).toBeVisible({ timeout: 15000 });

    // Open it. Opening a folder is a real navigation now
    // (`/content/{spaceId}/{folderId}`), so wait for the folder's own view
    // to have settled — it is empty at this point — before using the
    // toolbar it re-renders.
    await page.getByText(folderName, { exact: true }).click();
    await expect(page).toHaveURL(/\/content\/[0-9a-f-]{36}\/[0-9a-f-]{36}/);
    await expect(page.getByText("Nothing here yet")).toBeVisible({ timeout: 15000 });

    // Create a project inside it — the folder is already the default
    // destination, so Add new -> Blank project only needs a name.
    await page.getByRole("button", { name: "Add new" }).click();
    await page.getByRole("menuitem", { name: "Blank project" }).click();
    await expect(page.getByRole("dialog").getByText("New project", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "New project" }).fill(projectName);
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page).toHaveURL(/\/map\//, { timeout: 30000 });

    // Back into the folder to move the project out to the space root.
    await page.goto("/content");
    await page.getByText(folderName, { exact: true }).click();
    await expect(page).toHaveURL(/\/content\/[0-9a-f-]{36}\/[0-9a-f-]{36}/);
    await expect(page.getByText(projectName)).toBeVisible({ timeout: 15000 });

    const projectCard = page.locator(".content-card").filter({ hasText: projectName });
    await projectCard.getByRole("button", { name: "More" }).click();
    await page.getByRole("button", { name: "Move to…" }).click();

    // MoveDialog opens targeting the space root by default, so "Move here"
    // moves the project straight back out of the folder.
    const moveHereButton = page.getByRole("button", { name: "Move here" });
    await expect(moveHereButton).toBeVisible();
    await moveHereButton.click();
    await expect(moveHereButton).toBeHidden({ timeout: 10000 });

    // Back at the root, the project is visible again.
    await page.goto("/content");
    await expect(page.getByText(projectName)).toBeVisible({ timeout: 15000 });

    // Share it with the team: Teams tab, Viewer role, Done.
    const rootCard = page.locator(".content-card").filter({ hasText: projectName });
    await rootCard.getByRole("button", { name: "More" }).click();
    // Exact — a substring match also catches the spaces panel's "Shared
    // with me" row.
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page.getByRole("tab", { name: "Teams" }).click();
    // ShareTeamsTab's rows are plain flex Boxes, not list items, and its
    // role picker is a button that opens a menu (not a native/ARIA
    // combobox) — the smallest element containing both the team's name and
    // that button is the row itself.
    const teamRow = page
      .locator("div")
      .filter({ hasText: SHARED_TEAM_NAME })
      .filter({ has: page.getByRole("button") })
      .last();
    await teamRow.getByRole("button").click();
    await page.getByRole("menuitem", { name: /^Viewer/ }).click();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: "Done" })).toBeHidden({ timeout: 10000 });

    // Delete it — it moves to the space's trash rather than being purged.
    await rootCard.getByRole("button", { name: "More" }).click();
    await page.getByRole("button", { name: "Delete" }).click();
    const deleteDialog = page.getByRole("dialog").filter({ hasText: "Delete 1 items" });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole("button", { name: "Delete" }).click();
    await expect(deleteDialog).toBeHidden({ timeout: 10000 });
    await expect(page.getByText(projectName)).toBeHidden({ timeout: 10000 });

    // Restore it from the personal space's Trash dialog. The dialog also has
    // a bulk "Restore {{count}}" button (header checkbox selection) whose
    // name contains "Restore" too, so the per-row button needs both an exact
    // name match and to be scoped to this item's own row.
    await page.getByRole("button", { name: "Trash" }).click();
    const trashDialog = page.getByRole("dialog").filter({ hasText: "Trash" });
    await expect(trashDialog.getByText(projectName)).toBeVisible({ timeout: 15000 });
    const trashRow = trashDialog
      .locator("div")
      .filter({ hasText: projectName })
      .filter({ has: page.getByRole("button", { name: "Restore", exact: true }) })
      .last();
    await trashRow.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(trashDialog.getByText(projectName)).toBeHidden({ timeout: 10000 });
    // Two "Close" buttons share that name (the header's icon button via
    // aria-label, and the footer's own text button) — either works, since
    // both call the same handler; `.last()` picks the footer one.
    await trashDialog.getByRole("button", { name: "Close" }).last().click();

    // The restored project is back in the space.
    await page.goto("/content");
    await expect(page.getByText(projectName)).toBeVisible({ timeout: 15000 });
  });
});
