import type { APIRequestContext } from "@playwright/test";
import { expect, request, test } from "@playwright/test";

import { locateContentCard } from "../fixtures/content";

// Same base the web app builds its API clients from (see lib/api/templates.ts).
// The source project and its workflow are fixtures, not part of what this spec
// checks, so they are created straight against core rather than clicked
// together through the map UI.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

const INITIAL_VIEW_STATE = {
  latitude: 48.1502132,
  longitude: 11.5696284,
  zoom: 12,
  min_zoom: 0,
  max_zoom: 20,
  bearing: 0,
  pitch: 0,
};

/** The layouts `core.db.seed_templates` publishes on the GOAT shelf. The
 * Catalog's Templates tab opens on that shelf, so these are what it lists on
 * an environment that has been seeded and has published nothing else. */
const GOAT_LAYOUT_TEMPLATES = [
  "Blank",
  "Single map - Portrait",
  "Single map - Landscape",
  "Poster - Portrait",
  "Poster - Landscape",
];

// Every step builds on the one before it — the template only exists once it
// has been saved, and only then can Home offer it — so the file runs in one
// worker, in order, rather than under the config's `fullyParallel`.
test.describe.configure({ mode: "serial" });

test.describe("Templates", () => {
  // Unique per run and the prefix of every artefact's name, so the cleanup
  // sweep can find all three by one search term and a re-run never collides
  // with a previous run's leftovers.
  const term = `e2etpl${Date.now()}`;
  const sourceProjectName = `${term} source`;
  const workflowName = `${term} workflow`;
  const templateName = `${term} template`;
  const usedProjectName = `${term} used`;

  let apiContext: APIRequestContext;
  let personalSpaceId: string;
  let sourceProjectId: string;
  let usedProjectId: string | undefined;

  test.beforeAll(async () => {
    apiContext = await request.newContext();

    const spacesResponse = await apiContext.get(`${API_URL}/api/v2/space`);
    expect(spacesResponse.ok()).toBeTruthy();
    const spaces: { id: string; kind: string }[] = await spacesResponse.json();
    const personalSpace = spaces.find((space) => space.kind === "personal");
    expect(personalSpace, "no personal space for the default user").toBeTruthy();
    personalSpaceId = personalSpace!.id;

    // `POST /project` 400s without a folder, so the personal space's own root
    // has to be resolved first — the one folder this caller owns named "home"
    // (a shared team root comes back named "home" too, but `is_owned: false`).
    const foldersResponse = await apiContext.get(`${API_URL}/api/v2/folder`);
    expect(foldersResponse.ok()).toBeTruthy();
    const folders: { id: string; name: string; is_owned: boolean }[] = await foldersResponse.json();
    const homeFolder = folders.find((folder) => folder.name === "home" && folder.is_owned);
    expect(homeFolder, "no owned personal 'home' folder found").toBeTruthy();

    // The workflow needs a real dataset behind its dataset node: an id that
    // resolves to nothing is skipped by `detect_workflow_inputs`, which would
    // leave the saved template with no inputs at all.
    const layersResponse = await apiContext.get(
      `${API_URL}/api/v2/content?space_id=${personalSpaceId}&types=layer&size=50`
    );
    expect(layersResponse.ok()).toBeTruthy();
    const layerFeed: { items: { id: string; name: string; layer_type: string }[] } =
      await layersResponse.json();
    const layer = layerFeed.items.find((item) => item.layer_type === "feature");
    expect(layer, "no feature layer in the personal space to build a workflow on").toBeTruthy();

    const projectResponse = await apiContext.post(`${API_URL}/api/v2/project`, {
      data: {
        folder_id: homeFolder!.id,
        name: sourceProjectName,
        initial_view_state: INITIAL_VIEW_STATE,
      },
    });
    expect(projectResponse.ok()).toBeTruthy();
    sourceProjectId = ((await projectResponse.json()) as { id: string }).id;

    // The dataset node carries `projectLayerId` as well as `layerId`, the way
    // one dragged off the project layer tree does, so the snapshot the save
    // freezes matches what the app itself would have written.
    const projectLayerResponse = await apiContext.post(
      `${API_URL}/api/v2/project/${sourceProjectId}/layer?layer_ids=${layer!.id}`
    );
    expect(projectLayerResponse.ok()).toBeTruthy();
    const projectLayers: { id: number; layer_id: string; name: string }[] = await projectLayerResponse.json();
    expect(projectLayers.length).toBeGreaterThan(0);

    const workflowResponse = await apiContext.post(`${API_URL}/api/v2/project/${sourceProjectId}/workflow`, {
      data: {
        name: workflowName,
        description: null,
        is_default: false,
        config: {
          nodes: [
            {
              id: "dataset-1",
              type: "dataset",
              position: { x: 120, y: 120 },
              zIndex: 1000,
              data: {
                type: "dataset",
                label: projectLayers[0].name,
                projectLayerId: projectLayers[0].id,
                layerId: projectLayers[0].layer_id,
                layerName: projectLayers[0].name,
                layerType: "feature",
              },
            },
          ],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          variables: [],
        },
      },
    });
    expect(workflowResponse.ok()).toBeTruthy();
  });

  test.afterAll(async () => {
    // One name-keyed sweep rather than three id-keyed deletes: a test that
    // failed part way through may have created an artefact whose id never
    // reached this file, and the search term is the prefix of all of them.
    // Every step is independent so a single failure cannot strand the rest.
    try {
      const feedResponse = await apiContext.get(
        `${API_URL}/api/v2/content?space_id=${personalSpaceId}&search=${term}&size=50`
      );
      if (feedResponse.ok()) {
        const feed: { items: { id: string; type: string }[] } = await feedResponse.json();
        for (const item of feed.items) {
          // Projects soft-delete into the space's trash, same as every
          // UI-driven spec's cleanup; templates delete outright.
          if (item.type === "project") await apiContext.delete(`${API_URL}/api/v2/project/${item.id}`);
          if (item.type === "template") await apiContext.delete(`${API_URL}/api/v2/template/${item.id}`);
        }
      }
    } catch {
      // Nothing left to do — the ids below are the fallback.
    }
    if (sourceProjectId) await apiContext.delete(`${API_URL}/api/v2/project/${sourceProjectId}`);
    if (usedProjectId) await apiContext.delete(`${API_URL}/api/v2/project/${usedProjectId}`);
    await apiContext.dispose();
  });

  test("the workflows panel's kebab saves a workflow as a template", async ({ page }) => {
    // `?mode=workflows` is read once on mount by `useMapUrlIntent`, which
    // dispatches the map mode and then strips the param.
    await page.goto(`/map/${sourceProjectId}?mode=workflows`);

    await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible({ timeout: 30000 });
    const workflowItem = page.locator("li").filter({ hasText: workflowName });
    await expect(workflowItem).toBeVisible({ timeout: 15000 });

    await workflowItem.getByRole("button", { name: "More Options" }).click();
    // The kebab's menu renders into a portal (`disablePortal={false}`), so the
    // click is scoped to the popper rather than the panel.
    await page.locator(".MuiPopper-root").getByRole("button", { name: "Save as template…" }).click();

    const dialog = page.getByRole("dialog").filter({ hasText: "Save as template" });
    await expect(dialog).toBeVisible();

    // The name field is the only one carrying a "Name" placeholder; the
    // dialog's other inputs are a bare textarea and a "Categories" combobox.
    await dialog.getByPlaceholder("Name").fill(templateName);

    // The dataset node's input is detected as `ship`, so the location defaults
    // (My Content → home) are all this save needs. Save stays disabled until
    // `POST /template/preview` has answered, which the click waits out.
    await dialog.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText(/Saved as template/)).toBeVisible({ timeout: 15000 });
    await expect(dialog).toBeHidden();
  });

  test("Home's template band lists the saved template under Mine", async ({ page }) => {
    await page.goto("/home");

    const band = page.locator("section").filter({ hasText: "Start from a template" });
    await expect(band).toBeVisible({ timeout: 15000 });

    await band.getByRole("button", { name: "Mine" }).click();
    await expect(band.getByText(templateName, { exact: true })).toBeVisible({ timeout: 15000 });
  });

  test("using the template from Home lands on a new project carrying the workflow", async ({ page }) => {
    await page.goto("/home");

    const band = page.locator("section").filter({ hasText: "Start from a template" });
    await expect(band).toBeVisible({ timeout: 15000 });
    await band.getByRole("button", { name: "Mine" }).click();

    // The card has no control of its own to open the preview — the whole
    // surface is the click target, so the name is what gets clicked.
    await band.getByText(templateName, { exact: true }).click();

    const preview = page.getByRole("dialog").filter({ hasText: templateName });
    await expect(preview).toBeVisible();
    await preview.getByRole("button", { name: "Use template" }).click();

    // The flow takes the preview's place in the same click. The account
    // owns projects by now, so it opens on "Add to a project" and the
    // new-project form is one click away.
    const useDialog = page.getByRole("dialog").filter({ hasText: "Add to a project" });
    await expect(useDialog).toBeVisible();
    await useDialog.getByRole("button", { name: "Create a new project" }).click();
    await expect(useDialog.getByText("Destination")).toBeVisible();
    await useDialog.getByLabel("Name", { exact: true }).fill(usedProjectName);

    // The inputs step lists the template's only input as shipping with it;
    // there is nothing to bind, so it is a look and a click.
    await useDialog.getByRole("button", { name: "Next" }).click();
    await expect(useDialog.getByText("Ships with template")).toBeVisible();
    await useDialog.getByRole("button", { name: "Create" }).click();

    await expect(page).toHaveURL(/\/map\/[0-9a-f-]{36}/, { timeout: 60000 });
    usedProjectId = new URL(page.url()).pathname.split("/").pop();

    // `templateResultHref` lands on `?mode=workflows&workflow=<id>`, so the
    // panel is already open on the copied workflow, which takes the new
    // project's name.
    await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible({ timeout: 30000 });
    await expect(page.locator("li").filter({ hasText: usedProjectName })).toBeVisible({ timeout: 15000 });
  });

  test("Content lists the template with the Template tag", async ({ page }) => {
    const card = await locateContentCard(page, templateName);
    expect(card, `no content card for "${templateName}"`).not.toBeNull();
    await expect(card!.getByText("Template", { exact: true })).toBeVisible();
  });

  test("the Catalog's Templates tab lists the seeded GOAT layouts", async ({ page }) => {
    await page.goto("/catalog?tab=templates");

    // The tab renders the browser inline, already on the GOAT shelf.
    for (const name of GOAT_LAYOUT_TEMPLATES) {
      await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 15000 });
    }
    await expect(page.getByText(/Showing \d+ of \d+ templates/)).toBeVisible();
  });
});
