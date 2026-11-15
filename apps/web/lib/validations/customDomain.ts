import * as z from "zod";

export const dnsStatusSchema = z.enum(["pending", "verified", "failed"]);
export const certStatusSchema = z.enum(["pending", "issuing", "active", "failed"]);
export const domainKindSchema = z.enum(["single"]); // wildcard reserved for v2

/** Server response shape (matches OrganizationDomainRead in core). */
export const customDomainSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  base_domain: z.string(),
  kind: domainKindSchema,
  dns_status: dnsStatusSchema,
  dns_status_message: z.string().nullable(),
  dns_last_checked_at: z.string().nullable(),
  cert_status: certStatusSchema,
  cert_status_message: z.string().nullable(),
  created_at: z.string(),
  assigned_project_id: z.string().uuid().nullable().optional(),
  assigned_project_name: z.string().nullable().optional(),
});

export type CustomDomain = z.infer<typeof customDomainSchema>;
export type DnsStatus = z.infer<typeof dnsStatusSchema>;
export type CertStatus = z.infer<typeof certStatusSchema>;
export type DomainKind = z.infer<typeof domainKindSchema>;

/**
 * Hostname per RFC 1035, lowercased, ≥2 labels, leftmost label cannot be
 * 'www', max length 253. Apex hostnames (e.g. ministry.de) are accepted —
 * they require A/AAAA records instead of CNAME, handled separately in the
 * DNS instructions UI.
 *
 * Mirrors the backend validator in
 * apps/core/src/core/schemas/organization_domain.py.
 */
export const HOSTNAME_REGEX =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The messages are i18n keys: the add dialog translates them. */
export const customDomainCreateSchema = z.object({
  base_domain: z
    .string()
    .min(3, "settings_domains_name_invalid")
    .max(253, "settings_domains_name_invalid")
    .transform((v) => v.trim().toLowerCase())
    .refine((v) => HOSTNAME_REGEX.test(v), "settings_domains_name_invalid")
    .refine((v) => v.split(".").length >= 2, "settings_domains_name_invalid")
    .refine((v) => !v.startsWith("www."), "settings_domains_name_www"),
});

/** True for apex domains (e.g. ministry.de). False for subdomains. */
export function isApexDomain(hostname: string): boolean {
  return hostname.split(".").length === 2;
}

export type CustomDomainCreate = z.infer<typeof customDomainCreateSchema>;

/** Empty-state-friendly status helper for the UI. */
export function describeOverallStatus(domain: CustomDomain): {
  state: "active" | "pending_dns" | "issuing" | "failed";
  label: string;
} {
  if (domain.dns_status === "failed") {
    return { state: "failed", label: "DNS check failed" };
  }
  if (domain.dns_status === "pending") {
    return { state: "pending_dns", label: "Waiting for DNS" };
  }
  if (domain.cert_status === "active") {
    return { state: "active", label: "Active" };
  }
  if (domain.cert_status === "failed") {
    return { state: "failed", label: "Certificate failed" };
  }
  return { state: "issuing", label: "Issuing certificate" };
}
