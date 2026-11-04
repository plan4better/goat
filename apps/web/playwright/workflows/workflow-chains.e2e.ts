import { expect, test } from "@playwright/test";
import { readFileSync } from "fs";
import * as path from "path";

import {
  BASE_DATA,
  type ChainProject,
  PUBLIC_TRANSPORT,
  SUPERMAERKTE,
  type StepResult,
  type WorkflowConfig,
  area,
  countWithin,
  createChainProject,
  dataset,
  edge,
  exportStep,
  largest,
  needsTransit,
  removeChainProject,
  runWorkflow,
  tool,
} from "../fixtures/workflowChains";

/**
 * Workflows that route, built with only the settings the assistant sets (a
 * walk without a speed, a public transport catchment without a travel
 * budget), run in Windmill on Leipzig's street network and public transport
 * data: every step must succeed with rows. The walk and public transport
 * workflows are the routing cases of the assistant's regression set
 * (apps/assistant/evals/workflow_runs.json), as the assistant's `to_config`
 * builds them; the heatmap is written here, as the set has none. goatlib's
 * workflow chain tests run the set's other cases and cover the steps that do
 * not route.
 *
 * They run in their own job (.github/workflows/workflow-chains.yml), which
 * installs the base data; anywhere else they are skipped.
 */
test.skip(!BASE_DATA, "needs Leipzig's base data: E2E_BASE_DATA (the workflow chains job sets it)");
// In order on one worker, so the datasets are uploaded once; every run goes through Windmill.
// A failing workflow is a finding, not a flake: no retry runs it, and the uploads, again.
test.describe.configure({ mode: "default", timeout: 900000, retries: 0 });
// Every request carries the owner's token (`apiAs`), so the spec needs none of the browser sessions the auth setup saves.
test.use({ storageState: { cookies: [], origins: [] } });

let project: ChainProject | undefined;

test.beforeAll(async () => {
  // A hook has the project's timeout, not the tests': four uploads, each an import job in Windmill.
  test.setTimeout(300000);
  project = await createChainProject("E2E Chains");
});

test.afterAll(async () => {
  test.setTimeout(120000);
  await removeChainProject(project);
});

test("a heatmap of the markets an area filter keeps", async () => {
  const steps = await runWorkflow(project!, "Märkte West erreichbar", {
    nodes: [
      dataset("shops", SUPERMAERKTE, area(12.33, 51.31, 12.385, 51.37)),
      tool("heat", "heatmap_closest_average", { routing_mode: "walking" }),
      exportStep("save", "Erreichbarkeit Märkte West"),
    ],
    edges: [edge("shops", "heat", "opportunity_layer_1_id"), edge("heat", "save", "input")],
  });
  expect(steps.heat.feature_count).toBeGreaterThan(0);
  expect(steps.save.feature_count).toBe(steps.heat.feature_count);
  // The filter keeps the markets west of 12.385, so the heatmap has cells around one it keeps (12.3725)
  // and none around one it drops (12.4225), out of a walk's reach from the kept ones.
  expect(await countWithin(steps.save.layer_id!, 12.365, 51.34, 12.38, 51.35)).toBeGreaterThan(0);
  expect(await countWithin(steps.save.layer_id!, 12.415, 51.34, 12.43, 51.35)).toBe(0);
});

/** A case of the assistant's regression set: what it covers, where it runs, and the workflow as `to_config` builds it. */
type RunCase = { note: string; run: string; config: WorkflowConfig };
type Step = WorkflowConfig["nodes"][number];
type Steps = Record<string, StepResult>;

/** The assistant's regression workflows that route (apps/assistant/evals/workflow_runs.json, `run: routing`). */
const RUNS_FILE = path.join(__dirname, "../../../assistant/evals/workflow_runs.json");
const routingCases = (JSON.parse(readFileSync(RUNS_FILE, "utf8")) as { cases: RunCase[] }).cases.filter(
  (runCase) => runCase.run === "routing"
);

/*
 * The checks of goatlib's test_assistant_runs.py, and one for public
 * transport. Each reads only a case's steps and connections, never its note,
 * so it holds for any routing workflow the set gains, and returns what does
 * not hold: one message per step, naming the case and the step.
 */

/** The aggregate tools. With a polygon area layer each keeps every area row, those without a source feature included. */
const AGGREGATES = ["aggregate_points", "aggregate_polygon"];

/** A public transport catchment's budget when it sets none: the budget follows the mode, 30 minutes, not the model's 15. */
const TRANSIT_BUDGET = 30;

/** A step of the case by its label and id, for a failure message. */
const named = (config: WorkflowConfig, nodeId: string): string => {
  const node = config.nodes.find((candidate) => candidate.id === nodeId);
  return `the step '${String(node?.data.label)}' (${nodeId})`;
};

/** The case's steps of a type (tool, export, dataset, ...). */
const stepsOf = (config: WorkflowConfig, kind: string): Step[] =>
  config.nodes.filter((node) => node.data.type === kind);

/** The case's tool steps that run one of the tools named. */
const toolsOf = (config: WorkflowConfig, processIds: string[]): Step[] =>
  stepsOf(config, "tool").filter((node) => processIds.includes(String(node.data.processId)));

/** A tool step's settings. */
const settingsOf = (node: Step): Record<string, unknown> =>
  (node.data.config as Record<string, unknown> | undefined) ?? {};

/** The steps connected into an input of a step. */
const feeders = (config: WorkflowConfig, nodeId: string, handle: string): string[] =>
  config.edges
    .filter((edge) => edge.target === nodeId && edge.targetHandle === handle)
    .map((edge) => edge.source);

/** The rows of a step's result, undefined for a step without one: a dataset step delivers its layer and leaves no result. */
const rows = (steps: Steps, nodeId: string): number | undefined =>
  steps[nodeId] === undefined ? undefined : (steps[nodeId].feature_count ?? 0);

/** Every tool step and export gives rows. */
const everyStepGivesRows = ({ note, config }: RunCase, steps: Steps): string[] =>
  [...stepsOf(config, "tool"), ...stepsOf(config, "export")]
    .filter((node) => !((rows(steps, node.id) ?? 0) > 0))
    .map((node) => `${note}: ${named(config, node.id)} gave no rows`);

/** An export saves as many rows as the step that feeds it. An export fed by a
 * dataset step is not checked: that step leaves no result to count. */
const exportsSaveTheirInput = ({ note, config }: RunCase, steps: Steps): string[] =>
  stepsOf(config, "export").flatMap((exported) =>
    feeders(config, exported.id, "input").flatMap((source) => {
      const expected = rows(steps, source);
      const saved = rows(steps, exported.id) ?? 0;
      return expected === undefined || saved === expected
        ? []
        : [
            `${note}: ${named(config, exported.id)} saved ${saved} rows, ` +
              `${named(config, source)} that feeds it gave ${expected}`,
          ];
    })
  );

/** A dissolve without group fields merges every feature into one. */
const dissolvesMergeEverything = ({ note, config }: RunCase, steps: Steps): string[] =>
  toolsOf(config, ["dissolve"])
    .filter((node) => !(settingsOf(node).dissolve_fields as unknown[] | undefined)?.length)
    .flatMap((node) => {
      const given = rows(steps, node.id) ?? 0;
      return given === 1
        ? []
        : [`${note}: ${named(config, node.id)} has no group fields but gave ${given} rows`];
    });

/** An aggregate into a polygon area layer gives one row per area. An area
 * layer delivered by a dataset step is not checked: that step leaves no
 * result to count. */
const aggregatesKeepTheirAreas = ({ note, config }: RunCase, steps: Steps): string[] =>
  toolsOf(config, AGGREGATES)
    .filter((node) => settingsOf(node).area_type === "polygon")
    .flatMap((node) =>
      feeders(config, node.id, "area_layer_id").flatMap((areaStep) => {
        const expected = rows(steps, areaStep);
        const given = rows(steps, node.id) ?? 0;
        return expected === undefined || given === expected
          ? []
          : [
              `${note}: ${named(config, node.id)} gave ${given} rows, ` +
                `the area layer from ${named(config, areaStep)} has ${expected}`,
            ];
      })
    );

/** A public transport catchment with no travel budget set reaches the mode's
 * budget: the largest `cost_step` of the layer an export saves it to is 30. A
 * catchment no export saves straight away is not checked: it leaves no layer
 * to read. */
const transitBudgetFollowsTheMode = async ({ note, config }: RunCase, steps: Steps): Promise<string[]> => {
  const problems: string[] = [];
  const unbudgeted = toolsOf(config, ["catchment_area_v2"]).filter((node) => {
    const { routing_mode, max_cost } = settingsOf(node);
    return routing_mode === "pt" && (max_cost === undefined || max_cost === null);
  });
  for (const catchment of unbudgeted) {
    const exports = stepsOf(config, "export").filter((node) =>
      feeders(config, node.id, "input").includes(catchment.id)
    );
    for (const exported of exports) {
      const layerId = steps[exported.id]?.layer_id;
      if (!layerId) {
        problems.push(`${note}: ${named(config, exported.id)} saved no layer`);
        continue;
      }
      const reached = await largest(layerId, "cost_step");
      if (reached !== TRANSIT_BUDGET) {
        problems.push(
          `${note}: ${named(config, catchment.id)} sets no budget, but the largest cost_step ` +
            `${named(config, exported.id)} saved is ${reached}, not ${TRANSIT_BUDGET}`
        );
      }
    }
  }
  return problems;
};

test("the assistant's regression set has workflows that route", () => {
  expect(routingCases.length).toBeGreaterThan(0);
});

for (const runCase of routingCases) {
  test(`an assistant workflow runs: ${runCase.note}`, async () => {
    test.skip(
      needsTransit(runCase.config) && !PUBLIC_TRANSPORT,
      "the public transport data is installed on main and nightly only"
    );
    const steps = await runWorkflow(project!, runCase.note.slice(0, 80), runCase.config);
    const problems = [
      ...everyStepGivesRows(runCase, steps),
      ...exportsSaveTheirInput(runCase, steps),
      ...dissolvesMergeEverything(runCase, steps),
      ...aggregatesKeepTheirAreas(runCase, steps),
      ...(await transitBudgetFollowsTheMode(runCase, steps)),
    ];
    expect(problems).toEqual([]);
  });
}
