import type { TFunction } from "i18next";

export type OrgRole =
  | "organization-owner"
  | "organization-admin"
  | "organization-editor"
  | "organization-viewer";
export type AssignableRole = Exclude<OrgRole, "organization-owner">;

/** Highest first: the order of the members list's Role column and the matrix. */
export const ORG_ROLE_ORDER: readonly OrgRole[] = [
  "organization-owner",
  "organization-admin",
  "organization-editor",
  "organization-viewer",
];

const DESCRIPTION_KEY: Record<OrgRole, string> = {
  "organization-owner": "role_description_owner",
  "organization-admin": "role_description_admin",
  "organization-editor": "role_description_editor",
  "organization-viewer": "role_description_viewer",
};

/** Each organization role's word (Eigentümer, Admin, Bearbeiter, Betrachter)
 * and its one line: the only place settings and Usage take role words from. */
export const roleWords = (t: TFunction): Record<OrgRole, { word: string; description: string }> =>
  Object.fromEntries(
    ORG_ROLE_ORDER.map((role) => [role, { word: t(role), description: t(DESCRIPTION_KEY[role]) }])
  ) as Record<OrgRole, { word: string; description: string }>;

/** The organization role in a list of role names: the highest one there is. */
export const orgRoleOf = (roles: readonly string[] | undefined): OrgRole | undefined =>
  ORG_ROLE_ORDER.find((role) => roles?.includes(role));
