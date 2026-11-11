import { type Page, expect, test } from "@playwright/test";

import { deleteContentItem } from "../fixtures/content";

/** The Workflows panel's "New" button opens a menu; "From scratch" creates
 * an empty workflow and opens its canvas. */
const newWorkflow = async (page: Page) => {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "From scratch" }).click();
};

test.describe("Workflow Management", () => {
  // Set by beforeEach, read by afterEach — safe as a describe-scoped
  // variable because Playwright never runs two tests of the same describe
  // concurrently within one worker.
  let projectName: string;

  test.beforeEach(async ({ page }) => {
    // Create a fresh project for workflow tests. The old dedicated
    // /projects page now redirects to /content; project creation lives
    // behind its "Add new" menu instead.
    await page.goto("/content");
    await page.getByRole("button", { name: "Add new" }).click();
    await page.getByRole("menuitem", { name: "Blank project" }).click();
    await expect(page.getByRole("dialog").getByText("New project", { exact: true })).toBeVisible();

    // The dialog asks for a name and nothing else — the destination is the
    // folder being browsed.
    projectName = `E2E Workflow Test ${Date.now()}`;
    await page.getByRole("textbox", { name: "New project" }).fill(projectName);
    await page.getByRole("button", { name: "Create project" }).click();

    await expect(page).toHaveURL(/\/map\//, { timeout: 30000 });
  });

  test.afterEach(async ({ page }) => {
    await deleteContentItem(page, projectName);
  });

  test("create a new workflow and see the canvas", async ({ page }) => {
    // Switch to Workflows tab
    await page.getByText("Workflows").click();

    // Should see workflows panel; exact, as the empty project's "No workflows yet" card is a heading too
    await expect(page.getByRole("heading", { name: "Workflows", exact: true })).toBeVisible();

    // Create a new workflow: "New" opens a menu, "From scratch" starts empty.
    await newWorkflow(page);

    // Should see the workflow canvas with toolbar
    await expect(page.getByRole("button", { name: "Run" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: "Select" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Zoom In" })).toBeVisible();

    // Tools panel should be visible with tool categories
    await expect(page.getByText("Geoprocessing")).toBeVisible();
    await expect(page.getByText("Buffer")).toBeVisible();
    await expect(page.getByText("Accessibility Indicators")).toBeVisible();
  });

  test("add a tool node by dragging it onto the canvas", async ({ page }) => {
    await page.getByText("Workflows").click();
    await newWorkflow(page);
    await expect(page.getByRole("button", { name: "Run" })).toBeVisible({ timeout: 5000 });

    // A real pointer drag: the palette reads what is dragged in React's
    // onDragStart, which synthetic DragEvents never reach.
    await page.getByText("Buffer", { exact: true }).first().dragTo(page.locator(".react-flow__pane"));
    await expect(page.locator(".react-flow__node").filter({ hasText: "Buffer" })).toBeVisible({
      timeout: 10000,
    });
  });

  test("a variable's label and description show where it is picked", async ({ page }) => {
    const label = "Maximum grouping distance";
    const description = "Largest distance between two points of one group, in metres.";

    await page.getByText("Workflows").click();
    await newWorkflow(page);
    await expect(page.getByRole("button", { name: "Run" })).toBeVisible({ timeout: 5000 });

    // Define the variable on one row: the technical name expressions use and
    // the label users see. The help text goes in the popover behind the row's
    // description button.
    await page.getByRole("button", { name: "Variables" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Add Variable" }).click();
    await dialog.getByRole("textbox", { name: "Name" }).fill("max_abstand_gruppierung");
    await dialog.getByRole("textbox", { name: "Label" }).fill(label);
    await dialog.getByRole("spinbutton", { name: "Default" }).fill("250");
    await dialog.getByRole("button", { name: "Add description" }).click();
    const descriptionField = page.getByRole("textbox", { name: "Description" });
    await descriptionField.fill(description);
    // A click beside the popover closes it and keeps the text.
    await page.mouse.click(5, 5);
    await expect(descriptionField).toBeHidden();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    // Reopened, the dialog shows what was saved: the label in its column, the
    // description behind a button that now offers to edit it.
    await page.getByRole("button", { name: "Variables" }).click();
    await expect(dialog.getByRole("textbox", { name: "Label" })).toHaveValue(label);
    const editDescription = dialog.getByRole("button", { name: "Edit description" });
    await editDescription.hover();
    await expect(page.getByRole("tooltip")).toHaveText(description);
    await editDescription.click();
    await expect(descriptionField).toHaveValue(description);
    // Escape leaves the popover without changing anything.
    await descriptionField.fill("Not kept");
    await page.keyboard.press("Escape");
    await expect(descriptionField).toBeHidden();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    // A tool input's variable menu lists it by label, with the name to type
    // beside it and the description on hover. Buffer's distances sit in its
    // Configuration section, which stays disabled until the tool has an
    // input layer, so a dataset node is connected to it first (an empty one
    // is enough: the connection is what enables the section).
    const pane = page.locator(".react-flow__pane");
    await page
      .getByText("Add dataset", { exact: true })
      .first()
      .dragTo(pane, { targetPosition: { x: 120, y: 150 } });
    await page
      .getByText("Buffer", { exact: true })
      .first()
      .dragTo(pane, { targetPosition: { x: 450, y: 150 } });
    const buffer = page.locator(".react-flow__node").filter({ hasText: "Buffer" });
    await expect(buffer).toBeVisible({ timeout: 10000 });
    const dataset = page.locator(".react-flow__node").filter({ hasNotText: "Buffer" }).first();
    await dataset.locator(".react-flow__handle.source").first().click();
    await buffer.locator('.react-flow__handle.target[data-handleid="input_layer_id"]').click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await buffer.click();
    await page.getByRole("button", { name: "Insert variable" }).first().click();
    const item = page.getByRole("menuitem").filter({ hasText: label });
    await expect(item).toContainText("{{@max_abstand_gruppierung}}");
    await item.hover();
    // Filtered: while the menu is open more than one tooltip is in the DOM.
    await expect(page.getByRole("tooltip").filter({ hasText: description })).toHaveText(description);

    // Picked, the field holds the reference and names the variable by label.
    await item.click();
    await expect(page.getByTestId("variable-reference-label")).toHaveText(label);
  });

  test("the canvas zooms out below React Flow's default limit", async ({ page }) => {
    await page.getByText("Workflows").click();
    await newWorkflow(page);
    await expect(page.getByRole("button", { name: "Run" })).toBeVisible({ timeout: 5000 });

    // React Flow stops at 0.5 by default, too tight to see a large workflow
    // as a whole; the canvas allows zooming out to 0.1.
    const scale = async () =>
      page
        .locator(".react-flow__viewport")
        .evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
    const zoomOut = page.getByRole("button", { name: "Zoom Out" });
    for (let i = 0; i < 20; i++) await zoomOut.click();
    await expect.poll(scale).toBeLessThan(0.5);
    expect(await scale()).toBeGreaterThanOrEqual(0.1 - 1e-6);
  });

  test("tools panel search works", async ({ page }) => {
    await page.getByText("Workflows").click();
    await newWorkflow(page);
    await expect(page.getByRole("button", { name: "Run" })).toBeVisible({ timeout: 5000 });

    // Search for a tool
    const searchBox = page.getByPlaceholder("Search");
    await searchBox.fill("buffer");

    // Buffer should be visible, other tools should be hidden
    await expect(page.getByText("Buffer")).toBeVisible();
    await expect(page.getByText("Geoprocessing")).toBeVisible();

    // Clear search and verify all categories return
    await searchBox.clear();
    await expect(page.getByText("Accessibility Indicators")).toBeVisible();
    await expect(page.getByText("Geoanalysis")).toBeVisible();
    await expect(page.getByText("Data Management")).toBeVisible();
  });
});
