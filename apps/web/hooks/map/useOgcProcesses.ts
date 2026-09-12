/**
 * React hooks for OGC API Processes
 *
 * Provides hooks for fetching process list, descriptions, and executing processes
 */
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import useSWRMutation from "swr/mutation";

import { apiRequestAuth } from "@/lib/api/fetcher";
import { PROCESSES_BASE_URL } from "@/lib/constants";

import type {
  CategorizedTool,
  OGCJobStatus,
  OGCProcessDescription,
  OGCProcessList,
  ToolCategory,
} from "@/types/map/ogc-processes";

const PROCESSES_API_URL = `${PROCESSES_BASE_URL}/processes`;

// ============================================================================
// Fetchers
// ============================================================================

async function fetchProcessList(language: string): Promise<OGCProcessList> {
  const response = await apiRequestAuth(PROCESSES_API_URL, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Accept-Language": language,
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch process list");
  }

  return response.json();
}

async function fetchProcessDescription(processId: string, language: string): Promise<OGCProcessDescription> {
  const response = await apiRequestAuth(`${PROCESSES_API_URL}/${processId}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Accept-Language": language,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch process description for ${processId}`);
  }

  return response.json();
}

interface ExecuteProcessArgs {
  processId: string;
  inputs: Record<string, unknown>;
}

async function executeProcess(_url: string, { arg }: { arg: ExecuteProcessArgs }): Promise<OGCJobStatus> {
  const { processId, inputs } = arg;

  const response = await apiRequestAuth(`${PROCESSES_API_URL}/${processId}/execution`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || `Failed to execute process ${processId}`);
  }

  return response.json();
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook to fetch the list of all available processes
 */
export function useProcessList() {
  const { i18n } = useTranslation();
  const language = i18n.language || "en";

  const { data, error, isLoading, mutate } = useSWR<OGCProcessList>(
    ["ogc-process-list", language],
    () => fetchProcessList(language),
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000, // Cache for 1 minute
    }
  );

  return {
    processes: data?.processes ?? [],
    links: data?.links ?? [],
    isLoading,
    error,
    mutate,
  };
}

/**
 * Hook to fetch a specific process description with full input/output details
 */
export function useProcessDescription(processId: string | undefined) {
  const { i18n } = useTranslation();
  const language = i18n.language || "en";

  const { data, error, isLoading, mutate } = useSWR<OGCProcessDescription>(
    processId ? [`ogc-process-${processId}`, language] : null,
    () => (processId ? fetchProcessDescription(processId, language) : Promise.reject("No process ID")),
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000,
    }
  );

  return {
    process: data,
    isLoading,
    error,
    mutate,
  };
}

/**
 * Hook to execute a process
 */
export function useProcessExecution() {
  const { trigger, isMutating, error, data } = useSWRMutation("ogc-execute", executeProcess);

  const execute = async (processId: string, inputs: Record<string, unknown>) => {
    return trigger({ processId, inputs });
  };

  return {
    execute,
    isExecuting: isMutating,
    error,
    jobStatus: data,
  };
}

// ============================================================================
// Utility Hooks
// ============================================================================

const DEFAULT_CATEGORY: ToolCategory = "geoprocessing";

const isValidCategory = (category: string | undefined): category is ToolCategory => {
  return (
    category === "geoprocessing" ||
    category === "geoanalysis" ||
    category === "data_management" ||
    category === "accessibility_indicators" ||
    category === "other"
  );
};

/**
 * Hook to get processes organized by category
 * Filters out processes marked as hidden (x-ui-toolbox-hidden: true)
 * Uses x-ui-category from backend API for category assignment
 */
export function useCategorizedProcesses() {
  const { processes, isLoading, error } = useProcessList();

  // Filter out processes hidden from toolbox
  const visibleProcesses = processes.filter((process) => !process["x-ui-toolbox-hidden"]);

  const categorizedProcesses = visibleProcesses.map((process): CategorizedTool => {
    // Use x-ui-category from API, fallback to default
    const apiCategory = process["x-ui-category"];
    const category = isValidCategory(apiCategory) ? apiCategory : DEFAULT_CATEGORY;

    return {
      ...process,
      category,
    };
  });

  const byCategory = categorizedProcesses.reduce(
    (acc, process) => {
      if (!acc[process.category]) {
        acc[process.category] = [];
      }
      acc[process.category].push(process);
      return acc;
    },
    {} as Record<ToolCategory, CategorizedTool[]>
  );

  return {
    processes: categorizedProcesses,
    byCategory,
    isLoading,
    error,
  };
}

/**
 * Process descriptions for several tools in one request key — what a
 * dialog that looks across a workflow's tool nodes reads. Ids are sorted so
 * the same set always shares one cache entry; an id whose description is
 * still loading is simply absent from the map.
 */
export function useProcessDescriptions(processIds: string[]) {
  const { i18n } = useTranslation();
  const language = i18n.language || "en";
  const ids = Array.from(new Set(processIds)).sort();

  const { data, isLoading } = useSWR<Record<string, OGCProcessDescription>>(
    ids.length > 0 ? ["ogc-process-descriptions", language, ids.join(",")] : null,
    async () => {
      const entries = await Promise.all(
        ids.map(async (id) => [id, await fetchProcessDescription(id, language)] as const)
      );
      return Object.fromEntries(entries);
    },
    { revalidateOnFocus: false, dedupingInterval: 60000 }
  );

  return { processes: data ?? {}, isLoading };
}
