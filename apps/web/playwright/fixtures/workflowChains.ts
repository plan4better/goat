import { type APIRequestContext, expect } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { GEOAPI_URL, PROCESSES_URL, deleteDataset, uploadDataset } from "./datasets";
import {
  addDatasetsToProject,
  createProject,
  createWorkflowFromConfig,
  deleteProject,
  projectLayers,
} from "./projects";
import { API_URL, apiAs } from "./users";

/**
 * Workflows run as the editor runs them: saved in core, submitted to
 * processes, run by Windmill on the base data the workflow chains workflow
 * (.github/workflows/workflow-chains.yml) installs for Leipzig: the street
 * network on every run, the public transport data on main and nightly.
 *
 * The layers are the assistant eval's workflow project
 * (apps/assistant/evals/backends.py, WORKFLOW_LAYERS): its names and fields,
 * on the grid goatlib's chain tests use (tests/integration/tools/chains/world.py),
 * keyed by the project entry ids the assistant's drafts name. A spec uploads
 * them as the owner's datasets, and `bind` points each dataset step at them.
 */

/** Leipzig's street network is in the stack's data directory. */
export const BASE_DATA = !!process.env.E2E_BASE_DATA;
/** The public transport data is there too. */
export const PUBLIC_TRANSPORT = !!process.env.E2E_PUBLIC_TRANSPORT;

export const SCHULEN = 31;
export const EINWOHNER = 33;
export const SUPERMAERKTE = 34;
export const STADTBEZIRKE = 35;
/** Entries a draft may name that have no layer of their own here, and the layer standing in. */
const STAND_INS: Record<number, number> = { 32: SCHULEN };

type Geometry = { type: "Point"; coordinates: number[] } | { type: "Polygon"; coordinates: number[][][] };
type Feature = { type: "Feature"; properties: Record<string, string | number>; geometry: Geometry };

const range = (count: number): number[] => Array.from({ length: count }, (_, i) => i);
const point = (lon: number, lat: number): Geometry => ({ type: "Point", coordinates: [lon, lat] });
const box = (west: number, south: number, east: number, north: number): Geometry => ({
  type: "Polygon",
  coordinates: [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ],
});
const feature = (properties: Record<string, string | number>, geometry: Geometry): Feature => ({
  type: "Feature",
  properties,
  geometry,
});
const schoolType = (i: number): string => (i < 6 ? "Grundschule" : i < 9 ? "Gymnasium" : "Oberschule");
const CHAINS = ["Edeka", "Rewe", "Lidl", "Aldi"];
const DISTRICTS = ["Mitte", "Nordost", "Ost", "Südost"];

export const WORLD: Record<number, { name: string; features: Feature[] }> = {
  [SCHULEN]: {
    name: "Schulen",
    features: range(12).map((i) =>
      feature(
        { name: `Schule ${i + 1}`, schulart: schoolType(i) },
        point(12.335 + (i % 4) * 0.025, 51.315 + Math.floor(i / 4) * 0.02)
      )
    ),
  },
  [EINWOHNER]: {
    name: "Einwohner Raster",
    features: range(8).flatMap((x) =>
      range(6).map((y) =>
        feature(
          { einwohner: 50 + ((x * 37 + y * 101) % 850) },
          box(12.3275 + x * 0.0125, 51.3075 + y * 0.01, 12.34 + x * 0.0125, 51.3175 + y * 0.01)
        )
      )
    ),
  },
  [SUPERMAERKTE]: {
    name: "Supermärkte",
    features: range(12).map((i) =>
      feature(
        { name: `Markt ${i + 1}`, kette: CHAINS[i % 4] },
        point(12.3475 + (i % 4) * 0.025, 51.325 + Math.floor(i / 4) * 0.02)
      )
    ),
  },
  [STADTBEZIRKE]: {
    name: "Stadtbezirke",
    features: range(2).flatMap((x) =>
      range(2).map((y) =>
        feature(
          { name: DISTRICTS[x * 2 + y] },
          box(12.33 + x * 0.05, 51.31 + y * 0.03, 12.38 + x * 0.05, 51.34 + y * 0.03)
        )
      )
    ),
  },
};

type Node = { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> };
type Edge = { id: string; source: string; target: string; sourceHandle?: string; targetHandle: string };
export type WorkflowConfig = { nodes: Node[]; edges: Edge[]; variables?: Record<string, unknown>[] };
export type StepResult = { feature_count?: number; layer_id?: string; status?: string };

export type ChainProject = {
  projectId: string;
  folderId: string;
  /** By eval project entry id: the uploaded dataset and its entry in this project. */
  layers: Record<number, { layerId: string; linkId: number }>;
};

/** Runs `work` with an API client of the owner made for it: a token lives
 * five minutes, less than a public transport run takes. */
const asOwner = async <T>(work: (api: APIRequestContext) => Promise<T>): Promise<T> => {
  const api = await apiAs("owner");
  try {
    return await work(api);
  } finally {
    await api.dispose();
  }
};

/** A new project of the owner with the world's layers, uploaded as datasets named after `label`.
 * When making it fails, what it made so far is removed again. */
export const createChainProject = async (label: string): Promise<ChainProject> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-chains-"));
  const datasets: Record<number, string> = {};
  let projectId: string | undefined;
  try {
    for (const [entry, layer] of Object.entries(WORLD)) {
      const file = path.join(dir, `${entry}.geojson`);
      fs.writeFileSync(file, JSON.stringify({ type: "FeatureCollection", features: layer.features }));
      datasets[Number(entry)] = await asOwner((api) =>
        uploadDataset(api, `${label} ${layer.name}`, { path: file, contentType: "application/geo+json" })
      );
    }
    return await asOwner(async (api) => {
      projectId = await createProject(api, `${label} ${Date.now()}`);
      await addDatasetsToProject(api, projectId, Object.values(datasets));
      const project = await api.get(`${API_URL}/api/v2/project/${projectId}`);
      expect(project.ok(), await project.text()).toBeTruthy();
      const entries = await api.get(`${API_URL}/api/v2/project/${projectId}/layer`);
      expect(entries.ok(), await entries.text()).toBeTruthy();
      const links = (await entries.json()) as { id: number; layer_id: string }[];
      const layers: ChainProject["layers"] = {};
      for (const [entry, layerId] of Object.entries(datasets)) {
        const link = links.find((candidate) => candidate.layer_id === layerId);
        expect(link, `${layerId} is not in project ${projectId}`).toBeTruthy();
        layers[Number(entry)] = { layerId, linkId: link!.id };
      }
      return { projectId, folderId: ((await project.json()) as { folder_id: string }).folder_id, layers };
    });
  } catch (error) {
    // The cleanup's own failure must not hide why making the project failed.
    await asOwner(async (api) => {
      for (const layerId of Object.values(datasets)) await deleteDataset(api, layerId);
      await deleteProject(api, projectId);
    }).catch(() => undefined);
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** Removes the project, its datasets and the layers its workflows saved into it. Cleanup only. */
export const removeChainProject = async (project: ChainProject | undefined): Promise<void> => {
  if (!project) return;
  await asOwner(async (api) => {
    // Every layer of the project is the spec's own: the uploads and what the export steps saved.
    const saved = (await projectLayers(api, project.projectId).catch(() => [])).map((link) => link.layer_id);
    const uploaded = Object.values(project.layers).map((layer) => layer.layerId);
    // The datasets first: a project delete that fails leaves none of them behind.
    for (const layerId of new Set([...uploaded, ...saved])) await deleteDataset(api, layerId);
    await deleteProject(api, project.projectId).catch(() => undefined);
  });
};

const at = { x: 0, y: 0 };

/** A dataset step on a world layer by its eval project entry; `bind` points it at the project's own. */
export const dataset = (id: string, entry: number, filter?: Record<string, unknown>): Node => ({
  id,
  type: "dataset",
  position: at,
  data: { type: "dataset", label: WORLD[entry].name, projectLayerId: entry, ...(filter ? { filter } : {}) },
});

/** A dataset filter that keeps the features intersecting the box. */
export const area = (west: number, south: number, east: number, north: number): Record<string, unknown> => ({
  op: "and",
  expressions: [
    {
      id: "area",
      type: "spatial",
      attribute: "geom",
      expression: "s_intersects",
      value: JSON.stringify(box(west, south, east, north)),
    },
  ],
});

/** A tool step with only the settings given, as the assistant leaves the rest. */
export const tool = (id: string, processId: string, config: Record<string, unknown> = {}): Node => ({
  id,
  type: "tool",
  position: at,
  data: { type: "tool", processId, label: id, status: "idle", config },
});

/** An export step that saves its input as a new layer called `name`. */
export const exportStep = (id: string, name: string): Node => ({
  id,
  type: "export",
  position: at,
  data: { type: "export", label: name, datasetName: name, addToProject: true, overwritePrevious: false },
});

/** A connection into `targetHandle` of `target` ("input" for an export). */
export const edge = (source: string, target: string, targetHandle = "input_layer_id"): Edge => ({
  id: `${source}-${target}-${targetHandle}`,
  source,
  target,
  targetHandle,
});

/** The config with each dataset step reading this project's layer for the eval project entry it names. */
export const bind = (config: WorkflowConfig, project: ChainProject): WorkflowConfig => ({
  ...config,
  nodes: config.nodes.map((node) => {
    if (node.data.type !== "dataset") return node;
    const entry = Number(node.data.projectLayerId);
    const layer = project.layers[STAND_INS[entry] ?? entry];
    expect(layer, `no layer here for project entry ${entry}`).toBeTruthy();
    return { ...node, data: { ...node.data, layerId: layer.layerId, projectLayerId: layer.linkId } };
  }),
});

/** Tools that read the public transport data whatever their settings. */
const TRANSIT_TOOLS = new Set(["oev_gueteklassen", "trip_count"]);

/** Whether a workflow needs the public transport data: a step routes by public transport or reads the timetable. */
export const needsTransit = (config: WorkflowConfig): boolean =>
  config.nodes.some(
    (node) =>
      node.data.type === "tool" &&
      (TRANSIT_TOOLS.has(String(node.data.processId)) ||
        (node.data.config as Record<string, unknown> | undefined)?.routing_mode === "pt")
  );

type Job = {
  status: string;
  message?: string;
  node_errors?: Record<string, string>;
  node_status?: Record<string, unknown>;
};

/** How long a run may take: a public transport run loads Germany's timetable first. */
const RUN_TIMEOUT = 600000;

/**
 * Saves the config as a workflow of the project, runs it through processes as
 * the editor does, and returns each step's result once every step succeeded.
 */
export const runWorkflow = async (
  project: ChainProject,
  name: string,
  config: WorkflowConfig
): Promise<Record<string, StepResult>> => {
  const bound = bind(config, project);
  const jobId = await asOwner(async (api) => {
    const workflowId = await createWorkflowFromConfig(api, project.projectId, name, bound);
    const submitted = await api.post(`${PROCESSES_URL}/workflows/${workflowId}/execute`, {
      data: {
        project_id: project.projectId,
        folder_id: project.folderId,
        nodes: bound.nodes,
        edges: bound.edges,
        variables: bound.variables ?? [],
      },
    });
    expect(submitted.ok(), await submitted.text()).toBeTruthy();
    return ((await submitted.json()) as { job_id: string }).job_id;
  });
  let job: Job = { status: "accepted" };
  /** The last poll that got no job back, for the message when the run does not finish. */
  let missed = "";
  try {
    await expect
      .poll(
        async () => {
          // One failed poll (processes busy, a token grant refused) is not the run's outcome: the next one asks again.
          try {
            return await asOwner(async (api) => {
              const response = await api.get(`${PROCESSES_URL}/jobs/${jobId}`);
              if (!response.ok()) {
                missed = `${response.status()} ${await response.text()}`;
                return "running";
              }
              job = (await response.json()) as Job;
              missed = "";
              return job.status;
            });
          } catch (error) {
            missed = String(error);
            return "running";
          }
        },
        { timeout: RUN_TIMEOUT, intervals: [5000] }
      )
      .not.toMatch(/^(accepted|running)$/);
  } catch {
    // Cancelled, so the run saves nothing into the project after the cleanup has removed it.
    await asOwner((api) => api.delete(`${PROCESSES_URL}/jobs/${jobId}`)).catch(() => undefined);
    throw new Error(
      `${name}: job ${jobId} is still ${job.status} after ${RUN_TIMEOUT / 60000} minutes and was cancelled; ` +
        `steps ${JSON.stringify(job.node_status ?? {})}${missed ? `; last poll: ${missed}` : ""}`
    );
  }
  expect(
    job.status,
    `${name} (job ${jobId}): ${job.message ?? ""} ${JSON.stringify(job.node_errors ?? {})}`
  ).toBe("successful");
  return asOwner(async (api) => {
    const response = await api.get(`${PROCESSES_URL}/jobs/${jobId}/results`);
    expect(response.ok(), await response.text()).toBeTruthy();
    const { result } = (await response.json()) as {
      result: { status: string; node_results: Record<string, StepResult> };
    };
    expect(result.status, JSON.stringify(result)).toBe("success");
    return result.node_results;
  });
};

/** The largest value of a numeric field in a saved layer, as geoapi serves it. */
export const largest = async (layerId: string, field: string): Promise<number> =>
  asOwner(async (api) => {
    const response = await api.get(`${GEOAPI_URL}/collections/${layerId}/items?limit=1000`);
    expect(response.status(), await response.text()).toBe(200);
    const { features } = (await response.json()) as { features: { properties: Record<string, number> }[] };
    expect(features.length).toBeGreaterThan(0);
    return Math.max(...features.map((item) => item.properties[field]));
  });

/** How many features of a saved layer intersect the box, as geoapi serves them. Counts the
 * features returned rather than `numberMatched`, which geoapi gives as 0 when its count fails. */
export const countWithin = async (
  layerId: string,
  west: number,
  south: number,
  east: number,
  north: number
): Promise<number> =>
  asOwner(async (api) => {
    const response = await api.get(
      `${GEOAPI_URL}/collections/${layerId}/items?bbox=${west},${south},${east},${north}&limit=10000`
    );
    expect(response.status(), await response.text()).toBe(200);
    return ((await response.json()) as { features: unknown[] }).features.length;
  });
