import useSWR from "swr";

import { apiErrorOf } from "@/lib/api/apiError";
import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import type { CustomDomain } from "@/lib/validations/customDomain";

export const ORGANIZATIONS_API_BASE_URL = new URL("api/v2/organizations", process.env.NEXT_PUBLIC_API_URL)
  .href;

const orgDomainsUrl = (orgId: string) => `${ORGANIZATIONS_API_BASE_URL}/${orgId}/domains/`;

const oneDomainUrl = (orgId: string, domainId: string) =>
  `${ORGANIZATIONS_API_BASE_URL}/${orgId}/domains/${domainId}`;

const projectCustomDomainUrl = (projectId: string) =>
  new URL(`api/v2/project/${projectId}/public/custom-domain`, process.env.NEXT_PUBLIC_API_URL).href;

/**
 * List all custom domains for an organization.
 *
 * Rereads every 30s, so a status changed by a check elsewhere (the add
 * dialog, the periodic reconcile job) shows up. Reading never checks DNS.
 */
export function useOrganizationDomains(organizationId: string | undefined) {
  const { data, isLoading, error, mutate, isValidating } = useSWR<CustomDomain[]>(
    organizationId ? [orgDomainsUrl(organizationId)] : null,
    fetcher,
    { refreshInterval: 30_000 }
  );
  return { domains: data, isLoading, isError: error, mutate, isValidating };
}

export async function createCustomDomain(organizationId: string, baseDomain: string): Promise<CustomDomain> {
  const response = await apiRequestAuth(orgDomainsUrl(organizationId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_domain: baseDomain }),
  });
  if (!response.ok) {
    // A 409 is a domain registered already: the add dialog names it at the field.
    throw await apiErrorOf(response);
  }
  return await response.json();
}

export async function deleteCustomDomain(organizationId: string, domainId: string): Promise<void> {
  const response = await apiRequestAuth(oneDomainUrl(organizationId, domainId), {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`Failed to delete custom domain ${domainId}`);
  }
}

export async function recheckCustomDomain(organizationId: string, domainId: string): Promise<CustomDomain> {
  const response = await apiRequestAuth(`${oneDomainUrl(organizationId, domainId)}/recheck`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to recheck custom domain ${domainId}`);
  }
  return await response.json();
}

export async function assignDomainToProject(projectId: string, domainId: string): Promise<void> {
  const response = await apiRequestAuth(projectCustomDomainUrl(projectId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain_id: domainId }),
  });
  if (!response.ok) {
    throw new Error("Failed to assign domain to project");
  }
}

export async function unassignDomainFromProject(projectId: string): Promise<void> {
  const response = await apiRequestAuth(projectCustomDomainUrl(projectId), {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error("Failed to unassign domain from project");
  }
}
