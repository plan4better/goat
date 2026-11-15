/**
 * Every settings page, one flat path each, in the order of the settings nav.
 * The nav, the shell's guard and every link read these: no other file spells
 * a settings path (lib/__tests__/settingsRoutes.test.ts checks it). `/settings`
 * itself only redirects, in next.config.js.
 */
export const SETTINGS_ROUTES = {
  profile: "/settings/profile",
  preferences: "/settings/preferences",
  organization: "/settings/organization",
  members: "/settings/members",
  teams: "/settings/teams",
  domains: "/settings/domains",
  analytics: "/settings/analytics",
  ai: "/settings/ai",
  usage: "/settings/usage",
} as const;

export type SettingsRouteKey = keyof typeof SETTINGS_ROUTES;

/** One team's page. */
export const settingsTeamPath = (teamId: string): string =>
  `${SETTINGS_ROUTES.teams}/${encodeURIComponent(teamId)}`;

/** The usage page, opened on a tile (`?quota=`) when one is named. */
export const settingsUsagePath = (quota?: "credits" | "ai" | "storage" | "projects" | "editors"): string =>
  quota ? `${SETTINGS_ROUTES.usage}?quota=${quota}` : SETTINGS_ROUTES.usage;
