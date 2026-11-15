import type { CustomDomainConfig } from "@/lib/api/customDomainConfig";
import { type CustomDomain, describeOverallStatus } from "@/lib/validations/customDomain";

/** Custom domains are off on this instance (F13): core's config names no
 * CNAME target, and it refuses adding and checking. Unknown until it answers. */
export const customDomainsOff = (config?: CustomDomainConfig): boolean =>
  config !== undefined && !config.cname_target;

export type DomainState = ReturnType<typeof describeOverallStatus>["state"];

export const domainState = (domain: CustomDomain): DomainState => describeOverallStatus(domain).state;

export const STATUS_KEY: Record<DomainState, string> = {
  active: "settings_domains_status_active",
  pending_dns: "settings_domains_status_pending",
  issuing: "settings_domains_status_issuing",
  failed: "settings_domains_status_failed",
};

/** What a recheck found: DNS confirmed (moved on to the certificate or
 * active), still wrong (failed), or no change. */
export const recheckOutcome = (
  before: CustomDomain,
  after: CustomDomain
): "found" | "wrong" | "unchanged" => {
  const now = domainState(after);
  if (now === "failed") return "wrong";
  if (now !== domainState(before) && (now === "issuing" || now === "active")) return "found";
  return "unchanged";
};
