import type { UIMessage } from "ai";

/** The wire shapes of the assistant service (apps/assistant). */

export type Locale = "en" | "de";

export type AssistantSurfaceId =
  | "catalog"
  | "project.map"
  | "project.workflows"
  | "project.layouts"
  | "project.dashboard"
  | "none";

/** A project referenced with an @ mention: read as a source, never changed. */
export interface SourceRef {
  kind: "project";
  id: string;
  name: string;
}

export interface Viewport {
  center: [number, number];
  zoom: number;
  bearing?: number;
  pitch?: number;
  bbox?: [number, number, number, number];
}

interface WithSources {
  sources?: SourceRef[];
}

/**
 * Page context per surface, exactly as the server validates it
 * (`apps/assistant/src/assistant/context.py`, unknown keys are refused).
 */
export type NoPageContext = { surface: "none" } & WithSources;
export type CatalogContext = {
  surface: "catalog";
  q?: string;
  facets?: Record<string, string[]>;
  from?: string;
  to?: string;
  nuts?: string[];
  sortby?: string;
  selected_record_id?: string;
} & WithSources;
export type ProjectMapContext = {
  surface: "project.map";
  project_id: string;
  selected_layer_project_id?: number;
  viewport?: Viewport;
} & WithSources;
export type ProjectWorkflowsContext = {
  surface: "project.workflows";
  project_id: string;
  workflow_id?: string;
} & WithSources;
export type ProjectLayoutsContext = {
  surface: "project.layouts";
  project_id: string;
  layout_id?: string;
} & WithSources;
export type ProjectDashboardContext = { surface: "project.dashboard"; project_id: string } & WithSources;
export type PageContext =
  | NoPageContext
  | CatalogContext
  | ProjectMapContext
  | ProjectWorkflowsContext
  | ProjectLayoutsContext
  | ProjectDashboardContext;

export interface ProposalRow {
  /** A stable key the dock translates (`q`, `themes`, `bbox`, …). */
  k: string;
  v: string;
}
export interface ProposalTarget {
  project_id: string;
  name: string | null;
}
export interface CatalogFiltersPayload {
  q: string | null;
  facets: Record<string, string[]>;
  from: string | null;
  to: string | null;
  nuts: string[];
  sortby: string | null;
  number_matched: number;
}
export interface MapCamera {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}
export interface MapViewPayload {
  project_id: string;
  camera: MapCamera | null;
  bbox: [number, number, number, number] | null;
  layer_project_id: number | null;
}
interface ProposalBase {
  version: 1;
  title: string;
  rows: ProposalRow[];
}
export type CatalogFiltersProposal = ProposalBase & {
  kind: "catalog.filters";
  surface: "catalog";
  target: ProposalTarget | null;
  payload: CatalogFiltersPayload;
};
export type MapViewProposal = ProposalBase & {
  kind: "map.view";
  surface: "project.map";
  target: ProposalTarget;
  payload: MapViewPayload;
};
export type Proposal = CatalogFiltersProposal | MapViewProposal;

export const RUN_ERROR_CODES = [
  "run_timeout",
  "run_limit",
  "internal_error",
  "ai_unavailable",
  "provider_unreachable",
  "provider_busy",
  "provider_error",
  "goat_ai_unreachable",
  "goat_ai_busy",
  "goat_ai_error",
] as const;
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];

export interface RunStatusData {
  status: "failed" | "cancelled" | "interrupted";
  error: string | null;
  code: RunErrorCode | null;
}
export interface CaveatData {
  kind: string;
  text: string;
}
export interface UsageMetadata {
  model: string;
  provider?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}
/** One choice of an ask card question. Its `value` stays on the server and never reaches the page. */
export interface AskOption {
  label: string;
  description: string;
  recommended: boolean;
}
export interface AskQuestion {
  question: string;
  /** The chip above the question. */
  header: string;
  multi_select: boolean;
  options: AskOption[];
}
/** The `data-ask` part (contract "The ask card"): questions answered together with one Send. */
export interface AskCardData {
  card_id: string;
  questions: AskQuestion[];
}
/** The answer to one question: indexes into the question's `options`, and the free text. */
export interface AskAnswerItem {
  question: number;
  options: number[];
  other: string | null;
}
/** What the next message carries as `message.answer`; a stored user message returns it as `metadata.answer`. */
export interface AskAnswer {
  card_id: string;
  answers: AskAnswerItem[];
}
export interface AssistantMetadata {
  usage?: UsageMetadata;
  /** On a user message: the ask card it answers. */
  answer?: AskAnswer;
  /** When the message was stored (ISO 8601, UTC); only a reloaded message has it. */
  created_at?: string;
  /** On an answer: its run, which the Undo of its workflow edits names. */
  run_id?: string;
  /** On a reloaded answer: its workflow edits were undone. */
  undone?: boolean;
}
/** A workflow run the assistant started or waited for (`data-workflow-run`): one part per run, replaced as it goes. */
export interface WorkflowRunData {
  workflow_id: string;
  project_id: string;
  job_id: string | null;
  status: "running" | "succeeded" | "failed" | "cancelled" | "refused";
  /** The conversation started this run (not only waited for it). */
  started: boolean;
  card_id: string | null;
  done: number;
  total: number;
  /** The step that is running, by name. */
  step: string | null;
  started_at: string | null;
  saved: number;
}
export type AssistantDataParts = {
  proposal: Proposal;
  caveat: CaveatData;
  "run-status": RunStatusData;
  context: PageContext;
  ask: AskCardData;
  "workflow-run": WorkflowRunData;
};
export type AssistantMessage = UIMessage<AssistantMetadata, AssistantDataParts>;

/** One row of the history (`GET /conversations`). */
export interface ConversationSummary {
  id: string;
  title: string | null;
  origin_surface: string;
  project_id: string | null;
  project_name: string | null;
  /** null for a conversation that belongs to no project. */
  project_access: boolean | null;
  first_message: string | null;
  running: boolean;
  created_at: string;
  updated_at: string;
}
export interface ConversationRecord {
  id: string;
  project_id: string | null;
  origin_surface: string;
  title: string | null;
  created_at?: string;
  updated_at?: string;
}
export type Rating = "up" | "down";

/** The user's own rating of an answer. */
export interface AnswerFeedback {
  rating: Rating;
  comment: string | null;
}

export interface ConversationDetail {
  conversation: ConversationRecord;
  messages: AssistantMessage[];
  activeRunId: string | null;
  access: "ok" | "lost";
  projectName: string | null;
  /** The user's ratings, by answer id. */
  feedback?: Record<string, AnswerFeedback>;
}

export type UndoFn = () => void;

/**
 * What a page registers with the dock (spec §6.3). `project` names the
 * conversation's target on project pages; `uploadTo` is where a file dropped
 * on the dock is uploaded; `contextKey` changes when the state behind the
 * context chips changes, so they re-label.
 */
export interface AssistantSurfaceAdapter {
  surface: Exclude<AssistantSurfaceId, "none">;
  getContext: () => PageContext;
  project?: { id: string; name: string };
  contextKey?: string;
  preview?: (proposal: Proposal) => void;
  clearPreview?: () => void;
  apply?: (proposal: Proposal) => UndoFn | void | Promise<UndoFn | void>;
  uploadTo?: { projectId?: string; folderId?: string };
  /**
   * Fits the map to a layer of the open project and selects it in the layer list
   * (Map mode only). `select: false` leaves the user's selection as it is.
   */
  zoomToLayer?: (layerProjectId: number, options?: { select?: boolean }) => void | Promise<void>;
}
