import * as z from "zod";

export const analyticsProviderSchema = z.enum(["matomo"]);

/** Mirrors the backend MatomoConfig validator. The messages are i18n keys
 * (`settings_analytics_error_*`), shown by Settings › Analytics. */
export const matomoConfigSchema = z.object({
  provider: z.literal("matomo").default("matomo"),
  url: z
    .string()
    // Trimmed first, so an address of spaces alone counts as missing.
    .trim()
    .min(1, "settings_analytics_error_required")
    .url("settings_analytics_error_https")
    .refine((v) => v.startsWith("https://"), "settings_analytics_error_https")
    .refine((v) => {
      try {
        const u = new URL(v);
        return !u.search && !u.hash;
      } catch {
        return false;
      }
    }, "settings_analytics_error_query")
    // A path is fine (self-hosted Matomo often lives under one, e.g.
    // https://host.de/matomo/); the tracker appends matomo.php/matomo.js,
    // so normalize to a trailing slash.
    .transform((v) => (v.endsWith("/") ? v : `${v}/`)),
  site_id: z
    .string()
    .min(1, "settings_analytics_error_required")
    .max(16, "settings_analytics_error_site_id_long")
    .regex(/^\d+$/, "settings_analytics_error_digits"),
});

export type AnalyticsProvider = z.infer<typeof analyticsProviderSchema>;
export type MatomoConfig = z.infer<typeof matomoConfigSchema>;

/** Request body for POST/PUT /organizations/{org_id}/analytics. */
export const organizationAnalyticsCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "settings_analytics_error_required")
    .max(120, "settings_analytics_error_name_long"),
  provider: analyticsProviderSchema,
  config: matomoConfigSchema,
});

export type OrganizationAnalyticsCreate = z.infer<
  typeof organizationAnalyticsCreateSchema
>;

/** One item of GET /organizations/{org_id}/analytics. */
export const organizationAnalyticsSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  name: z.string(),
  provider: analyticsProviderSchema,
  config: matomoConfigSchema.partial({ provider: true }),
  usage_count: z.number().int().nonnegative().default(0),
  created_at: z.string(),
  updated_at: z.string(),
});

export type OrganizationAnalytics = z.infer<typeof organizationAnalyticsSchema>;

/** One published dashboard of the org with its analytics assignment. */
export const analyticsDashboardSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string(),
  analytics_id: z.string().uuid().nullable(),
});

export type AnalyticsDashboard = z.infer<typeof analyticsDashboardSchema>;
