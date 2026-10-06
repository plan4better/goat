import useSWR from "swr";

import { fetcher } from "@/lib/api/fetcher";
import { API_BASE_URL } from "@/lib/constants";

export const CREDITS_API_BASE_URL = new URL("api/v2/credits", API_BASE_URL).href;

// --- Response types ---

export interface CreditBalance {
  used_credits: number;
  total_credits: number | null;
  over_budget: boolean;
  plan_renewal_date: string | null;
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
  unit: number;
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

export const useCreditUsage = (page: number, size: number) => {
  const { data, isLoading, error, mutate } = useSWR<CreditUsagePage>(
    [`${CREDITS_API_BASE_URL}/usage`, { page, size }],
    fetcher
  );
  return { usage: data, isLoading, isError: error, mutate };
};

export const useCreditBreakdown = (groupBy: string) => {
  const { data, isLoading, error, mutate } = useSWR<CreditBreakdown>(
    [`${CREDITS_API_BASE_URL}/breakdown`, { group_by: groupBy }],
    fetcher
  );
  return { breakdown: data, isLoading, isError: error, mutate };
};

export const useStorageByLayer = () => {
  const { data, isLoading, error, mutate } = useSWR<StorageByLayer>(
    `${CREDITS_API_BASE_URL}/storage-by-layer`,
    fetcher
  );
  return { storage: data, isLoading, isError: error, mutate };
};
