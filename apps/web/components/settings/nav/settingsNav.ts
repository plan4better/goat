import { ICON_NAME } from "@p4b/ui/components/Icon";

import { SETTINGS_ROUTES, type SettingsRouteKey } from "@/lib/settingsRoutes";
import { featureNames, organizationRoles } from "@/lib/validations/organization";

export type SettingsNavGroupKey = "account" | "organization";
export type SettingsNavItemKey = SettingsRouteKey | "whiteLabel";

export interface SettingsNavItem {
  key: SettingsNavItemKey;
  /** i18n key of the row's label. */
  labelKey: string;
  /** i18n key of the "Gruppe" in "Gruppe › Seite". */
  groupLabelKey: string;
  icon?: ICON_NAME;
  /** None on the White Label parent and on skeletons. */
  href?: string;
  current: boolean;
  /** A row the roles may bring, drawn as a skeleton until they are known; it
   * keeps the label, icon and `current` of the row it stands for. */
  skeleton?: boolean;
  /** White Label: Domains and Analytics (desktop only). */
  children?: SettingsNavItem[];
  /** White Label while one of its children is current. */
  containsCurrent?: boolean;
}

export interface SettingsNavGroup {
  key: SettingsNavGroupKey;
  labelKey: string;
  items: SettingsNavItem[];
}

export interface SettingsNavInput {
  pathname: string;
  /** The caller's role names; undefined until the profile answers (or when it failed). */
  roles: readonly string[] | undefined;
  features: {
    /** `GET /users/me/features`; undefined while it loads. */
    billing: boolean | undefined;
    /** The organization's `white_label` feature; undefined while it loads. */
    whiteLabel: boolean | undefined;
  };
  /** `ASSISTANT_BASE_URL` is set. */
  assistant: boolean;
  /** Below `md`: White Label's children stand without their parent. */
  phone: boolean;
  /** A request the nav waits on (profile, features, organization) failed:
   * rows still unknown draw nothing instead of a skeleton that never ends. */
  failed?: boolean;
}

const ACCOUNT = "settings_nav_group_account";
const ORGANIZATION = "settings_nav_group_organization";
const WHITE_LABEL = "settings_nav_group_white_label";

export const isOrgAdminRole = (roles: readonly string[] | undefined): boolean =>
  !!roles && (roles.includes(organizationRoles.OWNER) || roles.includes(organizationRoles.ADMIN));

/** The organization's `white_label` feature (decision 10): `extras` null, as
 * self-hosted, means every feature; undefined while the organization loads. */
export const whiteLabelEnabled = (
  organization?: { extras?: string[] | null } | null
): boolean | undefined => {
  if (!organization) return undefined;
  const extras = organization.extras;
  return extras === null || extras === undefined ? true : extras.includes(featureNames.WHITE_LABEL);
};

const isAt = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/**
 * The settings nav as data: groups, rows, the current row. Rows only owners
 * and admins may get are row skeletons until the roles (and what else they
 * depend on) are known, so the nav draws at once (Settings load, L2).
 */
export function settingsNav({
  pathname,
  roles,
  features,
  assistant,
  phone,
  failed = false,
}: SettingsNavInput): SettingsNavGroup[] {
  const rolesKnown = roles !== undefined;
  const admin = isOrgAdminRole(roles);

  const row = (
    key: SettingsRouteKey,
    labelKey: string,
    groupLabelKey: string,
    icon?: ICON_NAME
  ): SettingsNavItem => ({
    key,
    labelKey,
    groupLabelKey,
    icon,
    href: SETTINGS_ROUTES[key],
    current: isAt(pathname, SETTINGS_ROUTES[key]),
  });
  /** The rows `make` would give, as one skeleton without a link that keeps
   * the current one's label and icon: the phone button names the page while
   * the roles load. */
  const skeleton = (key: SettingsNavItemKey, rows: SettingsNavItem[]): SettingsNavItem => {
    const shown = rows.find((item) => item.current) ?? rows[0];
    return {
      key,
      labelKey: shown.labelKey,
      groupLabelKey: shown.groupLabelKey,
      icon: shown.icon,
      current: shown.current,
      skeleton: true,
    };
  };
  /** An admin row: nothing once refused, a skeleton while unknown (nothing
   * once a request it waits on failed), else the rows. */
  const adminRows = (
    key: SettingsNavItemKey,
    condition: boolean | undefined,
    make: () => SettingsNavItem[]
  ) => {
    if ((rolesKnown && !admin) || condition === false) return [];
    if (!rolesKnown || condition === undefined) return failed ? [] : [skeleton(key, make())];
    return make();
  };

  const domains = row("domains", "settings_nav_domains", WHITE_LABEL);
  const analytics = row("analytics", "settings_nav_analytics", WHITE_LABEL);
  const whiteLabel: SettingsNavItem[] = phone
    ? [domains, analytics]
    : [
        {
          key: "whiteLabel",
          labelKey: "settings_nav_white_label",
          groupLabelKey: ORGANIZATION,
          icon: ICON_NAME.LINK,
          current: false,
          containsCurrent: domains.current || analytics.current,
          children: [domains, analytics],
        },
      ];

  return [
    {
      key: "account",
      labelKey: ACCOUNT,
      items: [
        row("profile", "settings_nav_profile", ACCOUNT, ICON_NAME.USER),
        row("preferences", "settings_nav_preferences", ACCOUNT, ICON_NAME.STYLE),
      ],
    },
    {
      key: "organization",
      labelKey: ORGANIZATION,
      items: [
        row("organization", "settings_nav_org_profile", ORGANIZATION, ICON_NAME.ORGANIZATION),
        ...adminRows("members", true, () => [
          row("members", "settings_nav_members", ORGANIZATION, ICON_NAME.ADD_USER),
        ]),
        row("teams", "settings_nav_teams", ORGANIZATION, ICON_NAME.USERS),
        ...adminRows("whiteLabel", features.whiteLabel, () => whiteLabel),
        ...adminRows("ai", assistant, () => [row("ai", "settings_nav_ai", ORGANIZATION, ICON_NAME.SPARKLES)]),
        ...adminRows("usage", features.billing, () => [
          row("usage", "settings_nav_usage", ORGANIZATION, ICON_NAME.CHART_PIE),
        ]),
      ],
    },
  ];
}

/**
 * Whether the caller may open `pathname`: false sends them to Profil (the
 * shell's guard), undefined while that is not known yet (a profile that fails
 * to load stays undefined and redirects nowhere; `failed` is not read here).
 * Unknown paths are left to the not-found page.
 */
export function settingsPageAllowed(
  pathname: string,
  { roles, features, assistant }: Omit<SettingsNavInput, "pathname" | "phone">
): boolean | undefined {
  const page = (Object.keys(SETTINGS_ROUTES) as SettingsRouteKey[]).find((key) =>
    isAt(pathname, SETTINGS_ROUTES[key])
  );
  if (!page || ["profile", "preferences", "organization", "teams"].includes(page)) return true;
  const condition =
    page === "domains" || page === "analytics"
      ? features.whiteLabel
      : page === "ai"
        ? assistant
        : page === "usage"
          ? features.billing
          : true;
  if (condition === false) return false;
  if (roles === undefined) return undefined;
  if (!isOrgAdminRole(roles)) return false;
  return condition === undefined ? undefined : true;
}
