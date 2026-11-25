import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

import {
  POINTS_FILE,
  PROCESSES_URL,
  deleteDataset,
  rowCount,
  uploadDataset,
  waitForJob,
} from "../fixtures/datasets";
import {
  addDatasetsToProject,
  createBufferWorkflow,
  createProject,
  deleteProject,
} from "../fixtures/projects";
import {
  type TemplateUseResult,
  applyTemplate,
  deleteTemplate,
  grantTemplate,
  templateByName,
  templateGrants,
} from "../fixtures/templates";
import { API_URL, type Role, actAs, apiAs, castOf, needsAuth, userOf } from "../fixtures/users";

/**
 * Templates used by other members of the owner's organization, and the
 * three ways a template's dataset reaches them: shipped (the owner's
 * dataset, read-only), copied with its rows, or copied empty — each user
 * gets their own editable copy, made by a `layer_copy` job when they use
 * the template.
 *
 * The owner saves a project template and a workflow template from a small
 * project of their own and shares both directly with the organization (a
 * template grant). An editor makes a project from the project template,
 * watches the copies arrive in the job tray, edits their copy, finds the
 * shipped dataset read-only and runs the project's workflow on the copy; a
 * second editor gets a copy of their own. The workflow template, added to
 * an existing project, gets one copy entry and keeps it on a second use.
 * A viewer's and a folder-shared template's cases are documented below.
 *
 * Every artefact is named after one per-run term and removed again; the
 * owner's datasets are uploaded by the spec itself (not the provisioned
 * ones), as a template grant widens who may read its datasets.
 */
needsAuth(test);
// Every step builds on the one before it; jobs run in Windmill.
test.describe.configure({ mode: "serial", timeout: 360000 });
// A step that cannot happen fails in a minute, not at the test's timeout.
test.use({ actionTimeout: 60000 });

const term = `e2etplshare${Date.now()}`;
const names = {
  planned: `${term} Planned`, // copied for every user, with its rows
  housing: `${term} Housing`, // copied for every user, empty
  districts: `${term} Districts`, // shipped, read-only
  source: `${term} source`,
  workflow: `${term} buffer`,
  projectTemplate: `${term} project template`,
  workflowTemplate: `${term} workflow template`,
  editorProject: `${term} editor project`,
  editor2Project: `${term} editor2 project`,
  targetProject: `${term} target`,
};
/** The suite's points file holds 26 features. */
const SOURCE_ROWS = 26;

const ids: {
  planned?: string;
  housing?: string;
  districts?: string;
  source?: string;
  projectTemplate?: string;
  workflowTemplate?: string;
  editorProject?: string;
  editor2Project?: string;
  targetProject?: string;
} = {};
/** What each role created, for the cleanup: projects and the datasets
 * (copies) the template's jobs made for them. */
const created: Partial<Record<Role, { projects: Set<string>; layers: Set<string>; jobs: Set<string> }>> = {};
const remember = (role: Role, kind: "projects" | "layers" | "jobs", id: string | null | undefined) => {
  if (!id) return;
  created[role] ??= { projects: new Set(), layers: new Set(), jobs: new Set() };
  created[role]![kind].add(id);
};
/** Records what a use created: its project and the copy jobs it started,
 * whose copies the cleanup must wait for. */
const rememberUse = (role: Role, result: TemplateUseResult) => {
  remember(role, "projects", result.project_id);
  for (const job of result.copy_jobs) remember(role, "jobs", job.job_id);
};

type Entry = { id: number; name: string; layer_id: string; user_id: string; locked?: boolean };

const entriesOf = async (api: APIRequestContext, projectId: string): Promise<Entry[]> => {
  const listed = await api.get(`${API_URL}/api/v2/project/${projectId}/layer`);
  expect(listed.ok(), await listed.text()).toBeTruthy();
  return (await listed.json()) as Entry[];
};

const workflowsOf = async (
  api: APIRequestContext,
  projectId: string
): Promise<
  { id: string; name: string; config: { nodes: { type: string; data: { layerId?: string } }[] } }[]
> => {
  const listed = await api.get(`${API_URL}/api/v2/project/${projectId}/workflow`);
  expect(listed.ok(), await listed.text()).toBeTruthy();
  return await listed.json();
};

/** Waits for every started copy job of a use and records the copies the
 * role now owns in the target project. */
const settleCopies = async (role: Role, result: TemplateUseResult): Promise<Entry[]> => {
  const api = await apiAs(role);
  try {
    for (const job of result.copy_jobs) {
      expect(job.error, `copy of ${job.source_layer_id}`).toBeNull();
      const finished = await waitForJob(api, job.job_id!);
      expect(finished.status, finished.message).toBe("successful");
    }
    const entries = await entriesOf(api, result.project_id);
    for (const entry of entries) {
      if (entry.user_id === userOf(role).id) remember(role, "layers", entry.layer_id);
    }
    return entries;
  } finally {
    await api.dispose();
  }
};

/** The use flow's answer, read off the request the dialog makes. */
const useResponse = (page: Page, templateId: string) =>
  page.waitForResponse(
    (response) =>
      response.url().includes(`/api/v2/template/${templateId}/use`) && response.request().method() === "POST"
  );

/** The template band on Home, on its default "Everyone" source, which
 * includes the templates shared with the caller. */
const openFromHome = async (page: Page, templateName: string) => {
  await page.goto("/home");
  const band = page.locator("section").filter({ hasText: "Start from a template" });
  await expect(band).toBeVisible({ timeout: 30000 });
  await expect(band.getByRole("button", { name: "Everyone", exact: true })).toBeVisible();
  await band.getByText(templateName, { exact: true }).click({ timeout: 30000 });
  const preview = page.getByRole("dialog").filter({ hasText: templateName });
  await expect(preview).toBeVisible();
  return preview;
};

/** Edits on the map open the layer's menu in the layer tree. */
const layerMenu = async (page: Page, layerName: string) => {
  const row = page.locator(".tree-item").filter({ hasText: layerName });
  await row.getByRole("button", { name: "More options" }).click({ timeout: 30000 });
};

test.beforeEach(async ({ context, baseURL }) => {
  // The spec reads the English labels; a member whose own preference is
  // another language would otherwise see that one. The app takes both
  // cookies or neither (then the account's settings), so both are set.
  await context.addCookies([
    { name: "client_language", value: "en", url: baseURL! },
    { name: "client_theme", value: "light", url: baseURL! },
  ]);
});

test.beforeAll(async () => {
  test.setTimeout(600000);
  const owner = await apiAs("owner");
  try {
    [ids.planned, ids.housing, ids.districts] = await Promise.all(
      [names.planned, names.housing, names.districts].map((name) => uploadDataset(owner, name, POINTS_FILE))
    );
    ids.source = await createProject(owner, names.source);
    await addDatasetsToProject(owner, ids.source, [ids.planned!, ids.housing!, ids.districts!]);
    // Saved the way most real workflows are: the dataset node names its
    // layer, not the project entry; the copy job has to follow it there.
    await createBufferWorkflow(
      owner,
      ids.source,
      { id: ids.planned!, name: names.planned },
      { name: names.workflow }
    );
  } finally {
    await owner.dispose();
  }
});

test.afterAll(async () => {
  // Every role's own artefacts with its own token; nothing a run did not
  // create is touched. Projects and datasets go to their owner's trash.
  for (const role of ["editor", "editor2"] as Role[]) {
    const mine = created[role];
    if (!mine) continue;
    const api = await apiAs(role);
    try {
      // A copy a job made after its test failed was never recorded: the
      // role's own datasets behind the project's entries are its copies,
      // once the jobs that write them are done.
      for (const jobId of mine.jobs) await waitForJob(api, jobId, 120000).catch(() => undefined);
      for (const projectId of mine.projects) {
        const listed = await api.get(`${API_URL}/api/v2/project/${projectId}/layer`);
        if (!listed.ok()) continue;
        for (const entry of (await listed.json()) as Entry[]) {
          if (entry.user_id === userOf(role).id) mine.layers.add(entry.layer_id);
        }
      }
      for (const projectId of mine.projects) await deleteProject(api, projectId);
      for (const layerId of mine.layers) await deleteDataset(api, layerId);
    } finally {
      await api.dispose();
    }
  }
  const owner = await apiAs("owner");
  try {
    // By name as well: a save whose test failed afterwards left no id.
    for (const name of [names.projectTemplate, names.workflowTemplate]) {
      await deleteTemplate(owner, (await templateByName(owner, name).catch(() => undefined))?.id);
    }
    await deleteTemplate(owner, ids.projectTemplate);
    await deleteTemplate(owner, ids.workflowTemplate);
    await deleteProject(owner, ids.source);
    for (const layerId of [ids.planned, ids.housing, ids.districts]) await deleteDataset(owner, layerId);
  } finally {
    await owner.dispose();
  }
});

test.describe("the owner", () => {
  actAs(test, "owner");

  test("saves the project as a template with a shipped, a copied and an empty-copied dataset, and shares it with the organization", async ({
    page,
  }) => {
    await page.goto(`/map/${ids.source}`);
    await expect(page.locator(".tree-item").filter({ hasText: names.planned })).toBeVisible({
      timeout: 30000,
    });

    // The project menu behind the logo in the map's header. By its name: until the
    // menu's code arrives the header holds only a placeholder, and the first button
    // would be another one.
    await page.locator("header").getByRole("button", { name: "Project menu", exact: true }).click();
    await page.getByText("Save project as template…", { exact: true }).click();
    const dialog = page.getByRole("dialog").filter({ has: page.getByLabel("Name", { exact: true }) });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name", { exact: true }).fill(names.projectTemplate);

    // One row per dataset; each says how users get it. Ship is the default.
    const choose = async (layerName: string, choice: string) => {
      await dialog.getByRole("combobox", { name: `${layerName} — How users get this dataset` }).click();
      await page.getByRole("option", { name: choice, exact: true }).click();
    };
    await choose(names.planned, "Copy for every user (with content)");
    await choose(names.housing, "Empty copy for every user");
    await expect(
      dialog.getByRole("combobox", { name: `${names.districts} — How users get this dataset` })
    ).toHaveText("Ship (read-only)");
    await expect(dialog.getByText(/A copy is made for every user when they use the template/)).toBeVisible();

    // Saving from the map's header closes the dialog without a toast (the
    // workflows panel's save has one), so the save is read off its request.
    const savedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v2/template" && response.request().method() === "POST"
    );
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect((await savedResponse).status()).toBe(201);
    await expect(dialog).toBeHidden();

    const owner = await apiAs("owner");
    try {
      const saved = await templateByName(owner, names.projectTemplate);
      expect(saved, "the saved project template").toBeTruthy();
      ids.projectTemplate = saved!.id;
      const byLayer = Object.fromEntries(saved!.inputs.map((input) => [input.layer_id, input]));
      expect(byLayer[ids.planned!]).toMatchObject({ mode: "copy", copy_content: true });
      expect(byLayer[ids.housing!]).toMatchObject({ mode: "copy", copy_content: false });
      expect(byLayer[ids.districts!]).toMatchObject({ mode: "ship" });
    } finally {
      await owner.dispose();
    }

    // Shared directly with the organization: the template's own Share
    // dialog, Teams tab, "Everyone at …", Viewer.
    await page.goto("/content");
    const card = page.locator(".content-card").filter({ hasText: names.projectTemplate });
    await card.getByRole("button", { name: "More" }).click({ timeout: 30000 });
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page.getByRole("tab", { name: "Teams" }).click();
    const everyone = page
      .locator("div")
      .filter({ hasText: /^Everyone at / })
      .filter({ has: page.getByRole("button") })
      .last();
    await everyone.getByRole("button").click();
    await page.getByRole("menuitem", { name: /^Viewer/ }).click();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: "Done" })).toBeHidden({ timeout: 10000 });

    const owner2 = await apiAs("owner");
    try {
      const grants = await templateGrants(owner2, ids.projectTemplate!);
      expect(grants).toContainEqual(
        expect.objectContaining({
          grantee_type: "organization",
          grantee_id: castOf().organization_id,
          role: "template-viewer",
        })
      );
    } finally {
      await owner2.dispose();
    }
  });

  test("saves the workflow as a template whose input is copied for every user", async ({ page }) => {
    await page.goto(`/map/${ids.source}?mode=workflows`);
    await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible({ timeout: 30000 });
    const workflowItem = page.locator("li").filter({ hasText: names.workflow });
    await workflowItem.getByRole("button", { name: "More options" }).click({ timeout: 30000 });
    await page.locator(".MuiPopper-root").getByRole("button", { name: "Save as template…" }).click();

    const dialog = page.getByRole("dialog").filter({ hasText: "Save as template" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name", { exact: true }).fill(names.workflowTemplate);
    // A workflow's dataset can also be asked for on use (the switch); kept,
    // it is shipped or copied like a project's.
    await expect(
      dialog.getByRole("checkbox", { name: `${names.planned} — Ship this dataset` })
    ).toBeChecked();
    await dialog.getByRole("combobox", { name: `${names.planned} — How users get this dataset` }).click();
    await page.getByRole("option", { name: "Copy for every user (with content)", exact: true }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/Saved as template/)).toBeVisible({ timeout: 30000 });

    const owner = await apiAs("owner");
    try {
      const saved = await templateByName(owner, names.workflowTemplate);
      expect(saved, "the saved workflow template").toBeTruthy();
      ids.workflowTemplate = saved!.id;
      expect(saved!.inputs).toEqual([
        expect.objectContaining({ mode: "copy", copy_content: true, layer_id: ids.planned }),
      ]);
      // Shared the same way as the project template, here through the API
      // the Share dialog calls (that dialog is covered above).
      await grantTemplate(owner, saved!.id, { type: "organization", id: castOf().organization_id });
    } finally {
      await owner.dispose();
    }
  });
});

test.describe("an editor of the organization", () => {
  actAs(test, "editor");

  test("makes a project from the shared template and gets their own copies, in the job tray", async ({
    page,
  }) => {
    // The preview says how each dataset comes: shipped, or copied for the
    // user (with its rows, or empty).
    const preview = await openFromHome(page, names.projectTemplate);
    const inputRow = (name: string) => preview.locator("div").filter({ hasText: name }).last();
    await expect(inputRow(names.planned)).toContainText("Copy for every user (with content)");
    await expect(inputRow(names.housing)).toContainText("Empty copy for every user");
    await expect(inputRow(names.districts)).toContainText("Ship this dataset");
    await preview.getByRole("button", { name: "Use template" }).click();

    // A project template only ever starts a new project: one step, its
    // form, with the copies announced underneath.
    const flow = page.getByRole("dialog").filter({ hasText: "Use template" });
    await expect(flow).toBeVisible();
    await expect(flow.getByRole("button", { name: "Add to a project" })).toHaveCount(0);
    await expect(flow.getByTestId("template-copies-hint")).toHaveText(
      "This template gives you your own editable copy of 2 datasets."
    );
    await flow.getByLabel("Name", { exact: true }).fill(names.editorProject);

    const answered = useResponse(page, ids.projectTemplate!);
    await flow.getByRole("button", { name: "Create", exact: true }).click();
    const result = (await (await answered).json()) as TemplateUseResult;
    rememberUse("editor", result);
    ids.editorProject = result.project_id;
    expect(result.copy_jobs).toHaveLength(2);
    await expect(page).toHaveURL(new RegExp(`/map/${result.project_id}`), { timeout: 60000 });
    await expect(page.getByText(/Creating your own copies of 2 datasets/)).toBeVisible();

    // The tray names each copy after its dataset and sees it finish.
    await page.getByRole("button", { name: "Job status" }).click({ timeout: 30000 });
    for (const job of result.copy_jobs) {
      const name = job.source_layer_id === ids.planned ? names.planned : names.housing;
      const item = page.locator(`[role="job_item"][aria-label="${job.job_id}"]`);
      await expect(item).toContainText(`Copy: ${name}`, { timeout: 30000 });
      await expect(item).toContainText("Finished successfully", { timeout: 120000 });
    }
    await page.keyboard.press("Escape");

    // Behind the entries: the editor's own copies (with rows, and empty)
    // and the owner's shipped dataset.
    const entries = await settleCopies("editor", result);
    const entry = (name: string) => entries.find((candidate) => candidate.name === name)!;
    const editor = await apiAs("editor");
    try {
      for (const name of [names.planned, names.housing]) {
        expect(entry(name).user_id, `${name} is the editor's copy`).toBe(userOf("editor").id);
        expect([ids.planned, ids.housing]).not.toContain(entry(name).layer_id);
      }
      expect(await rowCount(editor, entry(names.planned).layer_id)).toBe(SOURCE_ROWS);
      expect(await rowCount(editor, entry(names.housing).layer_id)).toBe(0);
      expect(entry(names.districts).layer_id).toBe(ids.districts);
    } finally {
      await editor.dispose();
    }
  });

  test("edits their copy, while the shipped dataset stays read-only", async ({ page }) => {
    const editor = await apiAs("editor");
    try {
      const copy = (await entriesOf(editor, ids.editorProject!)).find(
        (entry) => entry.name === names.planned
      )!;

      await page.goto(`/map/${ids.editorProject}`);
      // The shipped dataset's menu offers no editing.
      await layerMenu(page, names.districts);
      await expect(page.getByRole("button", { name: "Edit features", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");

      await layerMenu(page, names.planned);
      await page.getByRole("button", { name: "Edit features", exact: true }).click();
      await page.getByRole("button", { name: "Add a feature" }).click();
      const canvas = page.locator(".maplibregl-canvas");
      const box = (await canvas.boundingBox())!;
      await canvas.click({ position: { x: box.width * 0.6, y: box.height * 0.4 } });
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Features saved")).toBeVisible({ timeout: 30000 });

      await expect.poll(() => rowCount(editor, copy.layer_id), { timeout: 30000 }).toBe(SOURCE_ROWS + 1);
    } finally {
      await editor.dispose();
    }

    // The owner's datasets are as they were.
    const owner = await apiAs("owner");
    try {
      expect(await rowCount(owner, ids.planned!)).toBe(SOURCE_ROWS);
      expect(await rowCount(owner, ids.housing!)).toBe(SOURCE_ROWS);
    } finally {
      await owner.dispose();
    }
  });

  test("runs the project's workflow on their copy", async ({ page }) => {
    const editor = await apiAs("editor");
    try {
      const copy = (await entriesOf(editor, ids.editorProject!)).find(
        (entry) => entry.name === names.planned
      )!;
      // The workflow came with the project; its dataset node now reads the
      // copy, not the owner's dataset.
      const [workflow] = await workflowsOf(editor, ids.editorProject!);
      const datasetNode = workflow.config.nodes.find((node) => node.type === "dataset")!;
      expect(datasetNode.data.layerId).toBe(copy.layer_id);
    } finally {
      await editor.dispose();
    }

    await page.goto(`/map/${ids.editorProject}?mode=workflows`);
    await expect(page.locator(".react-flow__node").filter({ hasText: "Buffer" })).toBeVisible({
      timeout: 30000,
    });
    const started = page.waitForResponse(
      (response) =>
        /\/workflows\/[^/]+\/execute$/.test(response.url()) && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const { job_id: jobId } = (await (await started).json()) as { job_id: string };
    await expect(page.getByText("Workflow completed successfully")).toBeVisible({ timeout: 300000 });

    // The Buffer's result has one feature per point of the copy: the 26 the
    // owner's dataset has, plus the one the editor added.
    const runner = await apiAs("editor");
    try {
      const results = await runner.get(`${PROCESSES_URL}/jobs/${jobId}/results`);
      expect(results.ok(), await results.text()).toBeTruthy();
      const nodeResults = Object.values(
        ((await results.json()) as { result: { node_results: Record<string, { feature_count: number }> } })
          .result.node_results
      );
      expect(nodeResults.map((node) => node.feature_count)).toEqual([SOURCE_ROWS + 1]);
    } finally {
      await runner.dispose();
    }

    const owner = await apiAs("owner");
    try {
      expect(await rowCount(owner, ids.planned!)).toBe(SOURCE_ROWS);
    } finally {
      await owner.dispose();
    }
  });

  test("adds the workflow template to an existing project: one copy entry, kept on a second use", async ({
    page,
  }) => {
    const editor = await apiAs("editor");
    try {
      ids.targetProject = await createProject(editor, names.targetProject);
      remember("editor", "projects", ids.targetProject);
    } finally {
      await editor.dispose();
    }

    const preview = await openFromHome(page, names.workflowTemplate);
    await preview.getByRole("button", { name: "Use template" }).click();
    const flow = page.getByRole("dialog").filter({ hasText: "Use template" });
    await expect(flow).toBeVisible();
    await flow.getByPlaceholder("Search projects").fill(names.targetProject);
    await flow.getByRole("radio", { name: names.targetProject }).click();
    await flow.getByRole("button", { name: "Next" }).click();
    const inputs = page.getByRole("dialog").filter({ hasText: names.targetProject });
    await expect(inputs.getByText("Your own copy")).toBeVisible();

    const answered = useResponse(page, ids.workflowTemplate!);
    await inputs.getByRole("button", { name: "Add to project", exact: true }).click();
    const first = (await (await answered).json()) as TemplateUseResult;
    rememberUse("editor", first);
    expect(first.copy_jobs).toHaveLength(1);
    // Lands on the map's workflows panel (the app strips `?mode=` once read).
    await expect(page).toHaveURL(new RegExp(`/map/${ids.targetProject}`), { timeout: 60000 });
    await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible({ timeout: 30000 });

    // The copy's entry is named after the dataset and shows the editor's copy.
    const entries = await settleCopies("editor", first);
    const copies = entries.filter((entry) => entry.name === names.planned);
    expect(copies).toHaveLength(1);
    expect(copies[0].user_id).toBe(userOf("editor").id);
    expect(copies[0].layer_id).not.toBe(ids.planned);

    // A second use binds to that entry and copy again, and starts no job.
    const api = await apiAs("editor");
    try {
      const second = await applyTemplate(api, ids.workflowTemplate!, { project_id: ids.targetProject });
      rememberUse("editor", second);
      expect(second.copy_jobs).toEqual([]);
      const after = await entriesOf(api, ids.targetProject!);
      expect(after.filter((entry) => entry.name === names.planned)).toHaveLength(1);
      expect(after.filter((entry) => entry.layer_id === copies[0].layer_id)).toHaveLength(1);
      const workflow = (await workflowsOf(api, ids.targetProject!)).find((w) => w.id === second.workflow_id)!;
      expect(workflow.config.nodes.find((node) => node.type === "dataset")!.data.layerId).toBe(
        copies[0].layer_id
      );
    } finally {
      await api.dispose();
    }
  });
});

test.describe("a second editor", () => {
  actAs(test, "editor2");

  test("gets an independent copy from the same template, from the organization's content", async ({
    page,
  }) => {
    // A template granted to the organization is listed in the organization
    // space of Content (the items shared into it), not under "Shared with
    // me", which holds direct user grants only (`crud_content._granted_ids`).
    await page.goto("/content");
    await page.getByText("Organization", { exact: true }).first().click();
    const card = page.locator(".content-card").filter({ hasText: names.projectTemplate });
    await card.getByRole("button", { name: "More" }).click({ timeout: 30000 });
    await page.getByRole("button", { name: "Use template" }).click();

    const flow = page.getByRole("dialog").filter({ hasText: "Use template" });
    await expect(flow).toBeVisible();
    await flow.getByLabel("Name", { exact: true }).fill(names.editor2Project);

    const answered = useResponse(page, ids.projectTemplate!);
    await flow.getByRole("button", { name: "Create", exact: true }).click();
    const result = (await (await answered).json()) as TemplateUseResult;
    rememberUse("editor2", result);
    await expect(page).toHaveURL(new RegExp(`/map/${result.project_id}`), { timeout: 60000 });

    const entries = await settleCopies("editor2", result);
    const copy = entries.find((entry) => entry.name === names.planned)!;
    expect(copy.user_id).toBe(userOf("editor2").id);
    const editor = await apiAs("editor");
    try {
      const editorsCopy = (await entriesOf(editor, ids.editorProject!)).find(
        (e) => e.name === names.planned
      )!;
      expect(copy.layer_id).not.toBe(editorsCopy.layer_id);
    } finally {
      await editor.dispose();
    }
    // Made from the owner's dataset as it is: the first editor's point is
    // not in it.
    const editor2 = await apiAs("editor2");
    try {
      expect(await rowCount(editor2, copy.layer_id)).toBe(SOURCE_ROWS);
    } finally {
      await editor2.dispose();
    }
  });
});

test.describe("a viewer of the organization", () => {
  actAs(test, "viewer");

  test("sees the shared template but may not create a blank project", async ({ page }) => {
    // Current behaviour, documented: the template is listed and its
    // preview opens (and offers "Use template", see the fixme below) ...
    const preview = await openFromHome(page, names.projectTemplate);
    await expect(preview.getByText(names.projectTemplate).first()).toBeVisible();

    // ... while a project of their own is refused (organization-viewer has
    // no create-project).
    const viewer = await apiAs("viewer");
    try {
      const folders = await viewer.get(`${API_URL}/api/v2/folder`);
      const home = ((await folders.json()) as { id: string; name: string; is_owned: boolean }[]).find(
        (folder) => folder.name === "home" && folder.is_owned
      );
      const refused = await viewer.post(`${API_URL}/api/v2/project`, {
        data: { folder_id: home?.id, name: `${term} viewer blank` },
      });
      expect([401, 403]).toContain(refused.status());
    } finally {
      await viewer.dispose();
    }
  });

  // Known issue (review of feat/template-copy-datasets, 10.10.2026,
  // observation 4): an organization viewer may not create a blank project,
  // yet `POST /template/{id}/use` makes them one, with their own editable
  // copy, and neither can then be deleted by them (401 on DELETE). Until it
  // is decided which way that goes (refuse the use, or let viewers delete
  // their own content), the expected refusal is pending. Do not run this
  // body against a stack with the bug: it leaves a project and a copy the
  // viewer cannot remove.
  test.fixme("is refused using a template, like creating a blank project", async () => {
    const viewer = await apiAs("viewer");
    try {
      const folders = await viewer.get(`${API_URL}/api/v2/folder`);
      const home = ((await folders.json()) as { id: string; name: string; is_owned: boolean }[]).find(
        (folder) => folder.name === "home" && folder.is_owned
      );
      const used = await viewer.post(`${API_URL}/api/v2/template/${ids.projectTemplate}/use`, {
        data: { target_folder_id: home?.id, name: `${term} viewer use` },
      });
      expect([401, 403]).toContain(used.status());
    } finally {
      await viewer.dispose();
    }
  });
});

test.describe("a template shared only through its folder", () => {
  // A template reaches the organization through a folder grant, and whoever
  // may read a template may read the datasets it ships or copies with their
  // rows (rule 6c of `effective_role`), so the copy is made although no
  // grant on the template shared its datasets (T6).
  test("gives the organization's editors their copies", async () => {
    const owner = await apiAs("owner");
    const editor = await apiAs("editor");
    let folderId: string | undefined;
    let datasetId: string | undefined;
    let projectId: string | undefined;
    let templateId: string | undefined;
    let usedProjectId: string | undefined;
    try {
      const folder = await owner.post(`${API_URL}/api/v2/folder`, { data: { name: `${term} folder` } });
      expect(folder.ok(), await folder.text()).toBeTruthy();
      folderId = ((await folder.json()) as { id: string }).id;
      datasetId = await uploadDataset(owner, `${term} Folder input`, POINTS_FILE);
      projectId = await createProject(owner, `${term} folder source`);
      await addDatasetsToProject(owner, projectId, [datasetId]);
      const saved = await owner.post(`${API_URL}/api/v2/template`, {
        data: {
          name: `${term} folder template`,
          folder_id: folderId,
          source: { kind: "project", project_id: projectId },
          inputs: [
            {
              key: `layer:${datasetId}`,
              label: `${term} Folder input`,
              mode: "copy",
              copy_content: true,
              layer_id: datasetId,
            },
          ],
        },
      });
      expect(saved.ok(), await saved.text()).toBeTruthy();
      templateId = ((await saved.json()) as { id: string }).id;
      const shared = await owner.post(`${API_URL}/api/v2/folder/${folderId}/share`, {
        data: { grantee_type: "organization", grantee_id: castOf().organization_id, role: "folder-viewer" },
      });
      expect(shared.ok(), await shared.text()).toBeTruthy();

      // The editor sees the template through the folder ...
      expect(await templateByName(editor, `${term} folder template`)).toBeTruthy();
      // ... and should get their copy of its dataset.
      const folders = await editor.get(`${API_URL}/api/v2/folder`);
      const home = ((await folders.json()) as { id: string; name: string; is_owned: boolean }[]).find(
        (candidate) => candidate.name === "home" && candidate.is_owned
      );
      const result = await applyTemplate(editor, templateId, {
        target_folder_id: home!.id,
        name: `${term} folder use`,
      });
      usedProjectId = result.project_id;
      expect(result.copy_jobs).toHaveLength(1);
      expect(result.copy_jobs[0].error).toBeNull();
      const finished = await waitForJob(editor, result.copy_jobs[0].job_id!);
      expect(finished.status).toBe("successful");
    } finally {
      if (usedProjectId) {
        for (const entry of await entriesOf(editor, usedProjectId)) {
          if (entry.user_id === userOf("editor").id) await deleteDataset(editor, entry.layer_id);
        }
        await deleteProject(editor, usedProjectId);
      }
      await deleteTemplate(owner, templateId);
      await deleteProject(owner, projectId);
      await deleteDataset(owner, datasetId);
      if (folderId) await owner.delete(`${API_URL}/api/v2/folder/${folderId}`);
      await owner.dispose();
      await editor.dispose();
    }
  });
});
