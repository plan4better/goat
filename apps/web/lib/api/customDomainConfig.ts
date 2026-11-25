/**
 * Public DNS pointers the white-label UI needs (CNAME target hostname and
 * the canonical-target's resolved A record for apex use). Sourced from the
 * backend so there's a single source of truth — when the LB IP changes, the
 * backend resolves the canonical target's A record live and the UI follows.
 */

import useSWR from "swr";

import { fetcher } from "@/lib/api/fetcher";

export interface CustomDomainConfig {
  cname_target: string;
  apex_ipv4: string | null;
}

const url = new URL(
  "api/v2/custom-domain-config",
  process.env.NEXT_PUBLIC_API_URL
).href;

/** The config with its read state, for a part that shows a failed read. */
export function useCustomDomainConfigRead() {
  const { data, error, mutate } = useSWR<CustomDomainConfig>([url], fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });
  return { config: data, isError: error, mutate };
}

/** The config alone: undefined until it answers (or while its read fails). */
export function useCustomDomainConfig() {
  return useCustomDomainConfigRead().config;
}
