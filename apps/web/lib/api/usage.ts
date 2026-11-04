import useSWR, { mutate } from "swr";

import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { API_BASE_URL } from "@/lib/constants";

export const CREDITS_API_BASE_URL = new URL("api/v2/credits", API_BASE_URL).href;

/** Rows a usage list shows per page. */
export const PAGE_SIZE = 10;

// --- Query types ---

export type SortDir = "asc" | "desc";

/** A date range of the ledger: ISO instants, `since` inclusive, `until`
 * exclusive. Without `since`, `/breakdown` reads the current period, except
 * grouped by month or by period (the whole ledger); the export reads the
 * whole ledger. */
export interface UsageWindow {
  since?: string;
  until?: string;
}

/** Search, sort and one page of a list the server pages. */
export interface PageQuery {
  q?: string;
  sort?: string;
  dir?: SortDir;
  limit?: number;
  offset?: number;
}

export type BreakdownGroup =
  | "category"
  | "service"
  | "workflow"
  | "layer"
  | "member"
  | "tool"
  | "month"
  | "day"
  | "period";

/** The layer types the storage list filters by: feature layers by geometry,
 * tables and rasters by their type. */
export type StorageType = "point" | "line" | "polygon" | "table" | "raster";

// --- Response types ---

export interface CreditRate {
  category: string;
  rate: number;
  unit_basis: "minute" | "GB" | string;
}

/** One price step of an AI answer: the first tier whose `max_steps` is null or
 * at least the answer's steps sets its AI credits. */
export interface AiCreditTier {
  max_steps: number | null;
  credits: number;
}

export interface CreditBalance {
  /** What a credit buys, per category (compute, egress). AI answers are priced
   * by `ai_credit_tiers` instead. */
  rates?: CreditRate[];
  used_credits: number;
  total_credits: number | null;
  over_budget: boolean;
  /** The AI-credit pool, apart from the credits; it resets with them. */
  used_ai_credits: number;
  /** null: no limit. */
  total_ai_credits: number | null;
  /** The AI credits each editor seat brings, when the seats set the pool (a
   * subscription without a special deal); null for a trial or a deal. */
  ai_credits_per_editor: number | null;
  ai_credit_tiers: AiCreditTier[];
  plan_renewal_date: string | null;
  on_trial: boolean;
  credits_reset_at: string | null;
  /** Where the current credit period began (a trial's start); the breakdowns
   * count from it by default. null: no period known. */
  period_start: string | null;
  used_storage: number;
  total_storage: number | null;
  used_projects: number;
  total_projects: number | null;
  used_editors: number;
  total_editors: number | null;
  used_viewers: number;
  total_viewers: number | null;
}

export interface BreakdownRow {
  key: string | null;
  /** Credits; AI credits on the assistant's row (group_by=tool, category "ai"). */
  credits: number;
  units: number;
  count: number;
  runs?: number;
  compute?: number | null;
  traffic?: number | null;
  /** group_by=member: the member's name (null for traffic of public pages);
   * group_by=workflow and layer: its name (null once it is deleted). */
  name?: string | null;
  /** group_by=workflow: the project it belongs to. */
  project_id?: string | null;
  project_name?: string | null;
  /** group_by=workflow: when it last ran, ISO. */
  last_run?: string | null;
  /** group_by=layer: who owns it. */
  owner_id?: string | null;
  owner?: string | null;
  /** group_by=layer: the data requests charged. */
  requests?: number;
  /** group_by=period: the day the period ends (exclusive); null for the current one. */
  until?: string | null;
  /** group_by=tool: "compute" for a tool, "ai" for the assistant's row (key "assistant"). */
  category?: string;
  /** group_by=member and month: AI answers and their AI credits, never part of `credits`. */
  ai_answers?: number;
  ai_credits?: number;
}

/** `total`: the rows before paging. */
export interface CreditBreakdown {
  group_by: string;
  since: string | null;
  until: string | null;
  total: number;
  rows: BreakdownRow[];
}

export interface StorageLayer {
  layer_id: string;
  name: string;
  size_mb: number;
  geometry_type: string | null;
  type: "feature" | "table" | "raster";
  owner: string | null;
  /** null for a layer whose creator was removed: it stays the organization's
   * through its space. */
  owner_id: string | null;
  updated_at: string | null;
  /** The projects that use it; 0 for a layer in no project. */
  projects: number;
}

/** One page of the organization's live layers that match the filters, their
 * count (`total`), the trashed layers (they use storage until purged) and the
 * split of all storage, whatever the filters. */
export interface StorageByLayer {
  rows: StorageLayer[];
  total: number;
  trash: { count: number; size_mb: number };
  split: { in_projects_mb: number; unused_mb: number; trash_mb: number };
}

export interface OrgProject {
  project_id: string;
  name: string;
  /** null for a project whose creator was removed: it stays the
   * organization's through its space. */
  owner_id: string | null;
  owner: string | null;
  layers: number;
  updated_at: string | null;
}

/** One page of the organization's projects that match the filters, their
 * count (`total`), and the projects in the trash, whatever the filters: they
 * count against the plan's projects until the trash is purged. A core that
 * predates `trash` leaves it out. */
export interface OrgProjects {
  rows: OrgProject[];
  total: number;
  trash?: { count: number };
}

// --- SWR hooks ---

const CREDIT_BALANCE_URL = `${CREDITS_API_BASE_URL}/balance`;

/** `enabled: false` skips the request: the route exists only where billing is on. */
export const useCreditBalance = (enabled = true) => {
  const { data, isLoading, error, mutate } = useSWR<CreditBalance>(
    enabled ? CREDIT_BALANCE_URL : null,
    fetcher
  );
  return { balance: data, isLoading, isError: error, mutate };
};

/** Reads the balance again wherever it is shown (the dock after an answer). */
export const refreshCreditBalance = () => mutate(CREDIT_BALANCE_URL);

/** The query entries worth sending: an unset filter, a cleared search or a
 * null member would reach the server as `?q=` or `?member=null`. */
const compact = <Q extends object>(query: Q): Partial<Q> =>
  Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== "")
  ) as Partial<Q>;

/** A server-paged list keeps its last page in sight while the next page,
 * sort or search loads (`isLoading` stays true meanwhile). */
const KEEP_PAGE = { keepPreviousData: true } as const;

/** The ledger summed by `group`: every row without `limit`, one page with it
 * (kept in sight while the next one loads, as {@link KEEP_PAGE}). `member`:
 * only that member's rows (organization admins; others always get their
 * own). */
export const useCreditBreakdown = (
  group: BreakdownGroup,
  query: UsageWindow & PageQuery & { member?: string } = {},
  enabled = true
) => {
  const { data, isLoading, error, mutate } = useSWR<CreditBreakdown>(
    enabled ? [`${CREDITS_API_BASE_URL}/breakdown`, compact({ group_by: group, ...query })] : null,
    fetcher,
    query.limit === undefined ? undefined : KEEP_PAGE
  );
  // A kept page of another grouping (the workflows while the layers load)
  // would not fit the columns: only the same grouping's rows stay.
  const breakdown = data && data.group_by !== group ? undefined : data;
  return { breakdown, isLoading, isError: error, mutate };
};

/** One page of the organization's live layers, kept in sight while the next
 * one loads. `enabled: false` skips the request: the route answers 403 to
 * anyone but organization owners and admins, and a refusal is not retried. */
export const useStorageLayers = (
  query: PageQuery & { owner?: string; type?: StorageType; unused?: boolean },
  enabled = true
) => {
  const { data, isLoading, error, mutate } = useSWR<StorageByLayer>(
    enabled ? [`${CREDITS_API_BASE_URL}/storage-by-layer`, compact(query)] : null,
    fetcher,
    { shouldRetryOnError: false, ...KEEP_PAGE }
  );
  return { storage: data, isLoading, isError: error, mutate };
};

/** One page of the organization's projects, for owners and admins and kept
 * in sight as {@link useStorageLayers} is. */
export const useOrgProjects = (query: PageQuery & { owner?: string }, enabled = true) => {
  const { data, isLoading, error, mutate } = useSWR<OrgProjects>(
    enabled ? [`${CREDITS_API_BASE_URL}/projects`, compact(query)] : null,
    fetcher,
    { shouldRetryOnError: false, ...KEEP_PAGE }
  );
  return { projects: data, isLoading, isError: error, mutate };
};

// --- CSV exports ---

/** The file name of a `Content-Disposition` header, plain or RFC 5987 encoded.
 * A cross-origin page reads the header only where the server exposes it. */
const attachmentName = (header: string | null): string | null => {
  if (!header) return null;
  const encoded = header.match(/filename\*=(?:UTF-8)?''([^;]+)/i);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // A malformed encoding falls back to the plain name.
    }
  }
  return header.match(/filename="?([^";]+)"?/i)?.[1].trim() || null;
};

/** Saves the CSV a route streams: fetched with the user's token (a plain link
 * would carry none) and handed to the browser as a blob download. Rejects
 * with the response's `status` when the server refuses. */
const downloadCsv = async (url: string, fallbackName: string): Promise<void> => {
  const response = await apiRequestAuth(url);
  if (!response.ok) {
    throw Object.assign(new Error(`Export failed: ${response.status}`), { status: response.status });
  }
  const blob = await response.blob();
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = attachmentName(response.headers.get("Content-Disposition")) ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(downloadUrl);
};

const withQuery = (url: string, query: object): string => {
  const params = new URLSearchParams(
    Object.entries(compact(query)).map(([key, value]): [string, string] => [key, String(value)])
  );
  const search = params.toString();
  return search ? `${url}?${search}` : url;
};

/** The ledger rows of a range as CSV: credits (compute and traffic) or AI answers. */
export const downloadUsageCsv = (
  kind: "credits" | "ai",
  query: UsageWindow & { member?: string }
): Promise<void> =>
  downloadCsv(withQuery(`${CREDITS_API_BASE_URL}/usage/export`, { kind, ...query }), "goat-usage.csv");

/** Every layer the storage filters match, in their order, as CSV. */
export const downloadStorageCsv = (query: {
  q?: string;
  owner?: string;
  type?: StorageType;
  unused?: boolean;
  sort?: string;
  dir?: SortDir;
}): Promise<void> =>
  downloadCsv(withQuery(`${CREDITS_API_BASE_URL}/storage-by-layer/export`, query), "goat-storage.csv");
