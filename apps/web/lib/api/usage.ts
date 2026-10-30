import useSWR from "swr";

import { fetcher } from "@/lib/api/fetcher";
import { API_BASE_URL } from "@/lib/constants";

export const CREDITS_API_BASE_URL = new URL("api/v2/credits", API_BASE_URL).href;

// --- Response types ---

export interface CreditRate {
  category: string;
  rate: number;
  unit_basis: "minute" | "GB" | "1k_tokens" | string;
}

export interface CreditBalance {
  /** What a credit buys, per category (compute, egress, ai). */
  rates?: CreditRate[];
  used_credits: number;
  total_credits: number | null;
  over_budget: boolean;
  plan_renewal_date: string | null;
  on_trial: boolean;
  credits_reset_at: string | null;
  used_storage: number;
  total_storage: number | null;
  used_projects: number;
  total_projects: number | null;
  used_editors: number;
  total_editors: number | null;
  used_viewers: number;
  total_viewers: number | null;
}

export interface CreditUsageItem {
  created_at: string;
  category: string;
  action: string;
  unit: number | string;
  unit_type: string;
  rate: number;
  cost: number;
  member: string | null;
}

export interface CreditUsagePage {
  total: number;
  items: CreditUsageItem[];
}

export interface BreakdownRow {
  key: string | null;
  credits: number;
  units: number;
  count: number;
  runs?: number;
  compute?: number;
  traffic?: number;
  /** group_by=member: the member's name (null for traffic of public pages) */
  name?: string | null;
}

export interface CreditBreakdown {
  group_by: string;
  rows: BreakdownRow[];
}

export interface StorageLayer {
  layer_id: string;
  name: string;
  size_mb: number;
  geometry_type: string | null;
  owner: string | null;
}

export interface StorageByLayer {
  rows: StorageLayer[];
}

// --- SWR hooks ---

export const useCreditBalance = () => {
  const { data, isLoading, error, mutate } = useSWR<CreditBalance>(
    `${CREDITS_API_BASE_URL}/balance`,
    fetcher
  );
  return { balance: data, isLoading, isError: error, mutate };
};

/** `member`: only that member's rows (organization admins; others always get their own). */
export const useCreditUsage = (page: number, size: number, member?: string) => {
  const { data, isLoading, error, mutate } = useSWR<CreditUsagePage>(
    [`${CREDITS_API_BASE_URL}/usage`, { page, size, ...(member ? { member } : {}) }],
    fetcher
  );
  return { usage: data, isLoading, isError: error, mutate };
};

export const useCreditBreakdown = (groupBy: string, member?: string) => {
  const { data, isLoading, error, mutate } = useSWR<CreditBreakdown>(
    [`${CREDITS_API_BASE_URL}/breakdown`, { group_by: groupBy, ...(member ? { member } : {}) }],
    fetcher
  );
  return { breakdown: data, isLoading, isError: error, mutate };
};

/** `enabled: false` skips the request (the endpoint answers 403 to anyone but
 * organization owners and admins); a failed request stays quiet, the caller
 * hides the list. */
export const useStorageByLayer = (enabled = true) => {
  const { data, isLoading, error, mutate } = useSWR<StorageByLayer>(
    enabled ? `${CREDITS_API_BASE_URL}/storage-by-layer` : null,
    fetcher,
    { shouldRetryOnError: false }
  );
  return { storage: data, isLoading, isError: error, mutate };
};
