import { type APIRequestContext, expect, test } from "@playwright/test";

import { datasetIdByName, datasetOf } from "../fixtures/datasets";
import {
  addDatasetsToProject,
  createProject,
  createWorkflowFromConfig,
  deleteProject,
} from "../fixtures/projects";
import { AUTH_ON, apiAs } from "../fixtures/users";

/**
 * The workflow checks in the editor: an input that is not connected blocks
 * Run until it is connected, and a step that fails in a run shows its own
 * error on the step.
 */
// The failing run goes through Windmill and takes longer than the suite's default timeout.
test.describe.configure({ timeout: 360000 });

const POINTS = "E2E Points";

/** The suite's point dataset: provisioned with auth on, seeded by `core.scripts.seed_e2e` with auth off. */
const pointsDataset = async (api: APIRequestContext): Promise<string> => {
  const id = AUTH_ON ? datasetOf("points") : await datasetIdByName(api, POINTS);
  expect(id, `the "${POINTS}" dataset`).toBeTruthy();
  return id as string;
};

const datasetStep = (layerId: string) => ({
  id: "dataset-e2e",
  type: "dataset",
  position: { x: 100, y: 150 },
  data: {
    type: "dataset",
    label: POINTS,
    layerId,
    layerName: POINTS,
    geometryType: "point",
    layerType: "feature",
  },
});

let projectId: string;

test.beforeAll(async () => {
  const api = await apiAs("owner");
  try {
    const layerId = await pointsDataset(api);
    projectId = await createProject(api, `E2E Workflow Issues ${Date.now()}`);
    await addDatasetsToProject(api, projectId, [layerId]);

    // A dataset next to a Buffer, not connected yet; the Buffer's own settings are complete.
    await createWorkflowFromConfig(api, projectId, "Unconnected buffer", {
      nodes: [
        datasetStep(layerId),
        {
          id: "tool-buffer",
          type: "tool",
          position: { x: 450, y: 150 },
          data: {
            type: "tool",
            processId: "buffer",
            label: "buffer",
            status: "idle",
            config: { distances: [100], units: "meters" },
          },
        },
      ],
      edges: [],
    });

    // A query the checks accept (it reads only its input) that fails in DuckDB: the column does not exist.
    await createWorkflowFromConfig(api, projectId, "Failing query", {
      nodes: [
        datasetStep(layerId),
        {
          id: "tool-sql",
          type: "tool",
          // A workflow without a stored view opens at the canvas origin; placed here, the step's
          // issue badge (its bottom right corner) is inside the canvas, not under the Tools panel.
          position: { x: 350, y: 150 },
          data: {
            type: "tool",
            processId: "custom_sql",
            label: "custom_sql",
            status: "idle",
            config: { sql_query: "SELECT nope FROM input_1" },
          },
        },
      ],
      edges: [
        { id: "edge-sql", source: "dataset-e2e", target: "tool-sql", targetHandle: "input_layer_1_id" },
      ],
    });
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

test("an input that is not connected blocks Run until it is connected", async ({ page }) => {
  await page.goto(`/map/${projectId}?mode=workflows`);
  await page.getByRole("button", { name: "Unconnected buffer" }).click({ timeout: 30000 });

  const dataset = page.locator(".react-flow__node").filter({ hasText: POINTS });
  const buffer = page.locator(".react-flow__node").filter({ hasText: "Buffer" });
  await expect(buffer).toBeVisible({ timeout: 15000 });
  const input = buffer.locator('.react-flow__handle.target[data-handleid="input_layer_id"]');
  const run = page.getByRole("button", { name: "Run", exact: true });
  const badge = buffer.getByTestId("step-issue-badge");

  // The check answers shortly after the workflow opens.
  await expect(input).toHaveAttribute("data-issue", "true", { timeout: 15000 });
  // The toolbar's chip counts the workflow's issues; each step's badge is named the same way.
  await expect(
    page.getByRole("toolbar", { name: "Toolbar" }).getByRole("button", { name: /^\d+ issues?$/ })
  ).toBeVisible();
  await expect(run).toBeDisabled();
  await badge.hover();
  await expect(badge).toContainText("is not connected");

  // Handles connect by clicking one, then the other.
  await dataset.locator(".react-flow__handle.source").first().click();
  await input.click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  await expect(run).toBeEnabled({ timeout: 15000 });
  await expect(input).not.toHaveAttribute("data-issue", "true");
  await expect(badge).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^\d+ issues?$/ })).toHaveCount(0);
});

test("a step that fails in a run shows its own error on the step", async ({ page }) => {
  test.skip(!AUTH_ON, "needs Windmill, which the suite runs in its auth stage only");

  await page.goto(`/map/${projectId}?mode=workflows`);
  await page.getByRole("button", { name: "Failing query" }).click({ timeout: 30000 });

  const query = page.locator(".react-flow__node").filter({ hasText: "Custom SQL" });
  await expect(query).toBeVisible({ timeout: 15000 });
  const run = page.getByRole("button", { name: "Run", exact: true });
  await expect(run).toBeEnabled({ timeout: 15000 });
  await run.click();

  const badge = query.getByTestId("step-issue-badge");
  await expect(badge).toHaveAttribute("data-severity", "run", { timeout: 300000 });
  await badge.hover();
  await expect(badge).toContainText("The last run failed at this step");
  await expect(badge).toContainText("nope");
});
