import { mutate } from "swr";

import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { useAuthedSWR } from "@/lib/api/useAuthedSWR";
import type {
  TemplateCategoryFacet,
  TemplateCreate,
  TemplateGrantCreate,
  TemplateGrantRead,
  TemplateGrantsResponse,
  TemplateKind,
  TemplatePage,
  TemplatePreview,
  TemplateRead,
  TemplateSource,
  TemplateSourceFilter,
  TemplateUpdate,
  TemplateUseRequest,
  TemplateUseResult,
} from "@/lib/validations/template";
import {
  templateGrantReadSchema,
  templatePreviewSchema,
  templateReadSchema,
  templateUseResultSchema,
} from "@/lib/validations/template";

export const TEMPLATE_API_BASE_URL = new URL("api/v2/template", process.env.NEXT_PUBLIC_API_URL).href;

/** SWR key matcher for every template list/read request — mirrors
 * `matchesContentFeedKey`, so a save/use/publish/refresh can invalidate every
 * template list and detail in one call. */
export const matchesTemplatesKey = (key: unknown): boolean => {
  const url = Array.isArray(key) ? key[0] : key;
  return typeof url === "string" && url.startsWith(TEMPLATE_API_BASE_URL);
};

/** Refresh every template list/detail after a mutation (save, update,
 * delete, use, refresh, publish, unpublish, grant). */
export const refreshTemplates = () => mutate(matchesTemplatesKey);

type UseTemplatesParams = {
  source?: TemplateSourceFilter;
  kind?: TemplateKind;
  search?: string;
  /** The selected category tags as one comma-separated value, which is what
   * `GET /template` takes: a template matches only when it carries every one
   * of them (compared case-insensitively). */
  categories?: string;
  space_id?: string;
  folder_id?: string;
  /** Only templates saved from this source (`source_ref` ids). */
  source_project_id?: string;
  source_workflow_id?: string;
  source_layout_id?: string;
  page?: number;
  size?: number;
};

type UseTemplateCategoriesParams = {
  source?: TemplateSourceFilter;
  kind?: TemplateKind;
};

/** Drops the entries a caller left unset. `fetcher` builds its query string
 * with `new URLSearchParams(params)`, which writes an unset entry out as the
 * literal `kind=undefined` — a 422 from the enum-typed query parameters. SWR
 * hashes a key with an unset entry the same as one that omits it, so dropping
 * them here also lets a `kind`-less counts query share the grid query's
 * request rather than only appearing to. */
const definedParams = (
  params: Record<string, string | number | undefined>
): Record<string, string | number> =>
  Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)) as Record<
    string,
    string | number
  >;

export const useTemplates = (params: UseTemplatesParams | null) => {
  const { data, isLoading, error, mutate } = useAuthedSWR<TemplatePage>(
    params ? [TEMPLATE_API_BASE_URL, definedParams(params)] : null,
    fetcher
  );
  return { page: data, isLoading, isError: error, mutate };
};

/** The templates the caller owns that were saved from this exact source —
 * what the save dialog offers to update instead of saving a duplicate.
 * Owners only: a refresh needs the owner's permission on the template.
 * Newest first, so the first entry is the natural preselection. */
export const useTemplatesFromSource = (source: TemplateSource | null) => {
  const params: UseTemplatesParams | null = source
    ? {
        source: "all",
        source_project_id: source.project_id,
        ...(source.kind === "workflow" && source.workflow_id ? { source_workflow_id: source.workflow_id } : {}),
        ...(source.kind === "layout" && source.layout_id ? { source_layout_id: source.layout_id } : {}),
        size: 50,
      }
    : null;
  const { page, isLoading } = useTemplates(params);
  const templates = (page?.items ?? [])
    .filter((template) => template.my_role === "owner")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { templates, isLoading };
};

/** `GET /template/categories`: every category in use on the templates the
 * caller can read under the same `source`/`kind` the list is showing, with a
 * count each — the tag list behind the browser's filter popover and the save
 * dialog's autocomplete. The endpoint answers with a bare array. */
export const useTemplateCategories = (params: UseTemplateCategoriesParams = {}) => {
  const { data, isLoading, error } = useAuthedSWR<TemplateCategoryFacet[]>(
    // `source` is spelled out even when the caller left it unset — the
    // backend's own default — so a caller asking for the whole shelf shares
    // one SWR key (and one request) with one that named `all` itself.
    [`${TEMPLATE_API_BASE_URL}/categories`, definedParams({ source: "all", ...params })],
    fetcher
  );
  return { categories: data, isLoading, isError: error };
};

/** A single template. `include_config` is the API's own switch for the frozen
 * payload, which it returns to an owner/editor only. */
export const useTemplate = (id: string | null, includeConfig = false) => {
  const { data, isLoading, error, mutate } = useAuthedSWR<TemplateRead>(
    id ? [`${TEMPLATE_API_BASE_URL}/${id}`, includeConfig ? { include_config: true } : undefined] : null,
    fetcher
  );
  return { template: data, isLoading, isError: error, mutate };
};

/** The structured `detail` bodies the template endpoints answer with, in the
 * cases the UI has to name what went wrong rather than repeat a message:
 * `POST /template` 422s with the shipped input the caller cannot read,
 * `POST /template/{id}/publish` 409s with the datasets that are not catalog
 * data, and `POST /template/{id}/use` 409s when a project template's frozen
 * source copy is gone. */
export type TemplateErrorDetail =
  | { code: "template_input_not_readable"; layer_id?: string }
  | { code: "template_dataset_not_public"; layers: { id: string; name: string }[] }
  | { code: "template_source_missing" };

/** A failed template request, carrying the backend's structured `detail`
 * whenever it sent one — the callers localise `detail.code` themselves,
 * since only they know which of their own strings names the failure. */
export class TemplateApiError extends Error {
  readonly detail?: TemplateErrorDetail;

  constructor(message: string, detail?: TemplateErrorDetail) {
    super(message);
    this.name = "TemplateApiError";
    this.detail = detail;
  }
}

const parseDetail = (detail: unknown): TemplateErrorDetail | undefined => {
  if (typeof detail !== "object" || detail === null) return undefined;
  const code = (detail as { code?: unknown }).code;
  if (code === "template_input_not_readable") {
    const layerId = (detail as { layer_id?: unknown }).layer_id;
    return { code, layer_id: typeof layerId === "string" ? layerId : undefined };
  }
  if (code === "template_dataset_not_public") {
    const layers = (detail as { layers?: unknown }).layers;
    return {
      code,
      layers: Array.isArray(layers) ? (layers as { id: string; name: string }[]) : [],
    };
  }
  if (code === "template_source_missing") return { code };
  return undefined;
};

const readError = async (response: Response, fallback: string): Promise<never> => {
  let message = fallback;
  let detail: TemplateErrorDetail | undefined;
  try {
    const body = await response.json();
    if (typeof body?.detail === "string") message = body.detail;
    else detail = parseDetail(body?.detail);
  } catch {
    // no JSON body
  }
  throw new TemplateApiError(message, detail);
};

const requestJson = async (
  url: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown
): Promise<Response> =>
  apiRequestAuth(url, {
    method,
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });

export const previewTemplate = async (body: {
  source: TemplateSource;
  folder_id: string;
}): Promise<TemplatePreview> => {
  const response = await requestJson(`${TEMPLATE_API_BASE_URL}/preview`, "POST", body);
  if (!response.ok) await readError(response, "Failed to preview template");
  return templatePreviewSchema.parse(await response.json());
};

export const createTemplate = async (body: TemplateCreate): Promise<TemplateRead> => {
  const response = await requestJson(TEMPLATE_API_BASE_URL, "POST", body);
  if (!response.ok) await readError(response, "Failed to save template");
  return templateReadSchema.parse(await response.json());
};

export const updateTemplate = async (id: string, body: TemplateUpdate): Promise<TemplateRead> => {
  const response = await requestJson(`${TEMPLATE_API_BASE_URL}/${id}`, "PATCH", body);
  if (!response.ok) await readError(response, "Failed to update template");
  return templateReadSchema.parse(await response.json());
};

export const deleteTemplate = async (id: string): Promise<void> => {
  const response = await requestJson(`${TEMPLATE_API_BASE_URL}/${id}`, "DELETE");
  if (!response.ok) await readError(response, "Failed to delete template");
};

/** One template, read once rather than subscribed to — for a caller that
 * needs the frozen config in the middle of a flow (re-drawing the picture
 * after a refresh). The config comes back for an owner/editor only. */
export const readTemplate = async (id: string, includeConfig = false): Promise<TemplateRead> => {
  const url = new URL(`${TEMPLATE_API_BASE_URL}/${id}`);
  if (includeConfig) url.searchParams.set("include_config", "true");
  const response = await requestJson(url.href, "GET");
  if (!response.ok) await readError(response, "Failed to read template");
  return templateReadSchema.parse(await response.json());
};

export const refreshTemplate = async (id: string): Promise<TemplateRead> => {
  const response = await requestJson(`${TEMPLATE_API_BASE_URL}/${id}/refresh`, "POST");
  if (!response.ok) await readError(response, "Failed to refresh template");
  return templateReadSchema.parse(await response.json());
};

export const publishTemplate = async (id: string): Promise<TemplateRead> => {
  const response = await requestJson(`${TEMPLATE_API_BASE_URL}/${id}/publish`, "POST");
  if (!response.ok) await readError(response, "Failed to publish template");
  return templateReadSchema.parse(await response.json());
};

/** `publishTemplate` with T4's refusal as a value rather than an exception:
 * the 409 naming the datasets that are not catalog data is the one outcome
 * every publish caller has to render itself (it lists the datasets to the
 * author), while any other failure stays a thrown error. */
export const publishTemplateWithDetail = async (
  id: string
): Promise<{ ok: true; template: TemplateRead } | { ok: false; layers: { id: string; name: string }[] }> => {
  try {
    return { ok: true, template: await publishTemplate(id) };
  } catch (error) {
    if (error instanceof TemplateApiError && error.detail?.code === "template_dataset_not_public") {
      return { ok: false, layers: error.detail.layers };
    }
    throw error;
  }
};

export const unpublishTemplate = async (id: string): Promise<TemplateRead> => {
  const response = await requestJson(`${TEMPLATE_API_BASE_URL}/${id}/unpublish`, "POST");
  if (!response.ok) await readError(response, "Failed to unpublish template");
  return templateReadSchema.parse(await response.json());
};

/** `POST /template/{id}/use` (T7) — named `applyTemplate` since `use` alone
 * reads oddly as an export and collides with hook-naming conventions. */
export const applyTemplate = async (id: string, body: TemplateUseRequest): Promise<TemplateUseResult> => {
  const response = await requestJson(`${TEMPLATE_API_BASE_URL}/${id}/use`, "POST", body);
  if (!response.ok) await readError(response, "Failed to use template");
  return templateUseResultSchema.parse(await response.json());
};

export const useTemplateGrants = (id: string | null) => {
  const { data, isLoading, error, mutate } = useAuthedSWR<TemplateGrantsResponse>(
    id ? `${TEMPLATE_API_BASE_URL}/${id}/grant` : null,
    fetcher
  );
  return { grants: data?.grants ?? [], isLoading, isError: error, mutate };
};

export const addTemplateGrant = async (id: string, body: TemplateGrantCreate): Promise<TemplateGrantRead> => {
  const response = await requestJson(`${TEMPLATE_API_BASE_URL}/${id}/grant`, "POST", body);
  if (!response.ok) await readError(response, "Failed to add grant");
  return templateGrantReadSchema.parse(await response.json());
};

export const deleteTemplateGrant = async (id: string, grantId: string): Promise<void> => {
  const response = await requestJson(`${TEMPLATE_API_BASE_URL}/${id}/grant/${grantId}`, "DELETE");
  if (!response.ok) await readError(response, "Failed to remove grant");
};
