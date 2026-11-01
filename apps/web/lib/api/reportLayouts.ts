import useSWR, { mutate } from "swr";

import { SAVE_TIMEOUT_MS, changedElsewhere } from "@/lib/api/changedElsewhere";
import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import type { ReportLayout, ReportLayoutCreate, ReportLayoutUpdate } from "@/lib/validations/reportLayout";

import { PROJECTS_API_BASE_URL } from "./projects";

// ============================================================================
// SWR keys
// ============================================================================

/** SWR key of the report layout list of one project. */
const reportLayoutListKey = (projectId: string) => [`${PROJECTS_API_BASE_URL}/${projectId}/report-layout`];

/** SWR key of one report layout, including its stored config. The read hooks
 * key on an array, so an invalidation only matches when it uses the same
 * shape. */
const reportLayoutKey = (projectId: string, layoutId: string) => [
  `${PROJECTS_API_BASE_URL}/${projectId}/report-layout/${layoutId}`,
];

/** Invalidate one report layout so every consumer of its stored config — the
 * "Save as template" dialog, the print page — reads what the server now holds.
 * `updateReportLayout` calls this itself; the layout list key stays with the
 * callers, several of which update it optimistically without revalidating to
 * keep unsaved editor state. */
export const refreshReportLayout = (projectId: string, layoutId: string) =>
  mutate(reportLayoutKey(projectId, layoutId));

// ============================================================================
// Hooks
// ============================================================================

/**
 * Fetch all report layouts for a project
 */
export const useReportLayouts = (projectId?: string) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<ReportLayout[]>(
    () => (projectId ? reportLayoutListKey(projectId) : null),
    fetcher
  );

  return {
    reportLayouts: data,
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

/**
 * Fetch a specific report layout
 */
export const useReportLayout = (projectId?: string, layoutId?: string) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<ReportLayout>(
    () => (projectId && layoutId ? reportLayoutKey(projectId, layoutId) : null),
    fetcher
  );

  return {
    reportLayout: data,
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

// ============================================================================
// API Functions
// ============================================================================

/**
 * Create a new report layout
 */
export const createReportLayout = async (
  projectId: string,
  layout: ReportLayoutCreate
): Promise<ReportLayout> => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/report-layout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(layout),
  });
  if (!response.ok) {
    throw new Error("Failed to create report layout");
  }
  return await response.json();
};

/**
 * Read one report layout as core stores it now, with its revision.
 */
export const getReportLayout = async (projectId: string, layoutId: string): Promise<ReportLayout> =>
  (await fetcher(reportLayoutKey(projectId, layoutId))) as ReportLayout;

/**
 * Update an existing report layout. With `base_revision`, core saves only
 * while the stored layout is still at that revision and throws a
 * `ChangedElsewhereError` otherwise. Gives up after `SAVE_TIMEOUT_MS`.
 */
export const updateReportLayout = async (
  projectId: string,
  layoutId: string,
  layout: ReportLayoutUpdate
): Promise<ReportLayout> => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/report-layout/${layoutId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(layout),
    signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw (await changedElsewhere(response)) ?? new Error("Failed to update report layout");
  }
  const updated = await response.json();
  refreshReportLayout(projectId, layoutId);
  return updated;
};

/**
 * Delete a report layout
 */
export const deleteReportLayout = async (projectId: string, layoutId: string): Promise<void> => {
  const response = await apiRequestAuth(`${PROJECTS_API_BASE_URL}/${projectId}/report-layout/${layoutId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error("Failed to delete report layout");
  }
};

/**
 * Duplicate a report layout
 */
export const duplicateReportLayout = async (
  projectId: string,
  layoutId: string,
  newName?: string
): Promise<ReportLayout> => {
  let url = `${PROJECTS_API_BASE_URL}/${projectId}/report-layout/${layoutId}/duplicate`;
  if (newName) {
    url += `?new_name=${encodeURIComponent(newName)}`;
  }
  const response = await apiRequestAuth(url, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error("Failed to duplicate report layout");
  }
  return await response.json();
};
