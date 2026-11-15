import { describe, expect, it } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import { commonT } from "./commonI18n";

const EN = en as unknown as Record<string, string>;
const DE = de as unknown as Record<string, string>;

/** Every text the Usage page shows (settings/usage). */
const PLAIN_KEYS = [
  "usage_and_quotas",
  "traffic",
  "resets_on",
  "usage_ai_credits",
  "beta",
  "usage_ai_tier_next",
  "usage_ai_tier_above",
  "projects",
  "editors",
  "viewers",
  "group_by",
  "all_members",
  "credits",
  "usage_traffic_credits",
  "public_traffic",
  "unknown",
  "member",
  "usage_none",
  "remove_all",
  "usage_remove_filter",
  "usage_period",
  "usage_range_period",
  "usage_range_trial",
  "usage_range_last",
  "usage_range_d7",
  "usage_range_d30",
  "usage_range_m12",
  "usage_range_custom",
  "usage_range_span",
  "usage_from",
  "usage_to",
  "apply",
  "cancel",
  "usage_all_owners",
  "usage_export_csv",
  "usage_export_failed",
  "usage_ask_for_more",
  "usage_needs_attention",
  "usage_no_limit",
  "usage_fixed_by_plan",
  "usage_trial_limit",
  "usage_whole_trial",
  "usage_over_by",
  "usage_viewers_of",
  "usage_all_in_use",
  "usage_used",
  "usage_tile_storage",
  "usage_quotas",
  "usage_credits_period",
  "usage_trial_until",
  "usage_admins_only",
  "usage_trial_banner",
  "usage_talk_plan",
  "workflows",
  "tools",
  "layers",
  "members",
  "usage_group_periods",
  "usage_group_days",
  "usage_group_months",
  "usage_search_workflows",
  "usage_search_tools",
  "usage_search_layers",
  "usage_search_members",
  "workflow",
  "project",
  "layer",
  "owner",
  "day",
  "month",
  "usage_col_last_run",
  "usage_col_tool",
  "usage_col_share",
  "usage_col_compute",
  "usage_member_chip",
  "usage_search_chip",
  "usage_show_only",
  "usage_periods_whole",
  "usage_download_period",
  "usage_deleted_workflow",
  "usage_deleted_layer",
  "usage_deleted_project",
  "usage_public_pages_sub",
  "usage_period_open",
  "usage_amount_member",
  "usage_amount_no_limit",
  "usage_amount_used",
  "usage_amount_of_period",
  "usage_amount_of_period_open",
  "usage_amount_of_trial",
  "usage_phrase_period",
  "usage_phrase_trial",
  "usage_phrase_last",
  "usage_phrase_d7",
  "usage_phrase_d30",
  "usage_phrase_m12",
  "usage_phrase_custom",
  "usage_credits_explain",
  "usage_credits_limit",
  "usage_credits_limit_trial",
  "usage_credits_empty",
  "usage_credits_empty_hint",
  "usage_chart_credits_day",
  "usage_chart_credits_month",
  "usage_chart_ai_day",
  "usage_chart_ai_month",
  "usage_chart_label",
  "usage_ai_explain_rule",
  "usage_ai_explain_trial",
  "usage_ai_explain_no_limit",
  "usage_ai_explain_per_editor",
  "usage_ai_explain_own",
  "usage_ai_limit",
  "usage_ai_limit_trial",
  "usage_ai_empty",
  "usage_ai_empty_hint",
  "usage_empty_search",
  "usage_empty_search_hint",
  "usage_empty_range",
  "usage_empty_range_hint",
  "usage_load_error",
  "role",
  "type",
  "size",
  "search_projects",
  "table",
  "raster",
  "usage_show_ai_credits_of",
  "usage_amount_of",
  "usage_amount_over",
  "usage_amount_used_no_limit",
  "usage_amount_of_plan",
  "usage_amount_of_trial_limit",
  "usage_owner_chip",
  "usage_type_chip",
  "usage_role_chip",
  "usage_empty_filters",
  "usage_empty_filters_hint",
  "usage_col_updated",
  "usage_storage_explain",
  "usage_storage_limit",
  "usage_storage_over",
  "usage_storage_over_no_trash",
  "usage_split_in_projects",
  "usage_split_unused",
  "usage_not_in_project",
  "usage_unused",
  "usage_all_types",
  "usage_type_polygon",
  "usage_type_point",
  "usage_type_line",
  "usage_show_layers_of",
  "usage_storage_empty",
  "usage_storage_empty_hint",
  "usage_projects_explain",
  "usage_projects_limit",
  "usage_show_projects_of",
  "usage_owner_removed",
  "usage_projects_empty",
  "usage_projects_empty_hint",
  "usage_seats_title",
  "usage_seats_editors_of",
  "usage_seats_viewers_of",
  "usage_seats_line",
  "usage_seats_line_no_limit",
  "usage_seats_explain",
  "usage_seats_explain_ai",
  "usage_seats_limit",
  "usage_manage_members",
  "usage_all_roles",
  "usage_role_admins",
  "usage_role_invited",
  "usage_show_credits_of",
];

/** Texts holding a numeric range ("1–10 of 48"): the one dash they may carry,
 * as MUI's pagination writes it. */
const RANGE_KEYS = ["usage_range_text"];

/** Texts with a count: i18next picks `_one` or `_other`. */
const COUNTED_KEYS = [
  "usage_credits_count",
  "usage_ai_credits_count",
  "usage_ai_tier_first",
  "usage_ai_tier_steps",
  "usage_answers_count",
  "usage_runs",
  "usage_requests",
  "usage_entries",
  "usage_unit_credits",
  "usage_unit_ai",
  "usage_split_compute",
  "usage_split_traffic",
  "usage_noun_workflows",
  "usage_noun_tools",
  "usage_noun_layers",
  "usage_noun_members",
  "usage_noun_periods",
  "usage_noun_days",
  "usage_noun_months",
  "usage_noun_projects",
  "usage_split_trash",
  "usage_projects_no_limit",
  "usage_projects_trash",
  "usage_layers_count",
  "usage_seats_editors",
  "usage_seats_viewers",
];

/** The nouns of a range of rows: German counts them in the dative ("von 48
 * Werkzeugen") and names none in the nominative ("Keine Werkzeuge"). */
const NOUN_KEYS = COUNTED_KEYS.filter((key) => key.startsWith("usage_noun_"));

const forms = (key: string) => (key in EN ? [key] : [`${key}_one`, `${key}_other`]);
const allKeys = [...PLAIN_KEYS, ...COUNTED_KEYS].flatMap(forms);
const placeholders = (text: string) =>
  [...text.matchAll(/{{\s*(\w+)[^}]*}}|<(\w+)>/g)].map((m) => m[1] ?? m[2]).sort();

describe("usage page texts", () => {
  it("exist in English and German with the same placeholders", () => {
    for (const key of [...allKeys, ...RANGE_KEYS]) {
      expect(EN[key], key).toBeTruthy();
      expect(DE[key], key).toBeTruthy();
      expect(placeholders(DE[key]), key).toEqual(placeholders(EN[key]));
    }
  });

  it.each(["en", "de"] as const)("%s resolves every counted text in both forms", (language) => {
    const t = commonT(language);
    for (const key of COUNTED_KEYS) {
      for (const count of [1, 3]) expect(t(key, { count }), key).not.toBe(key);
    }
  });

  it("use no dashes inside sentences and address the reader as Sie", () => {
    for (const key of allKeys) {
      expect(EN[key], key).not.toMatch(/[—–]/);
      expect(DE[key], key).not.toMatch(/[—–]/);
      expect(DE[key], key).not.toMatch(/\b(du|dich|dir|dein\w*)\b/i);
    }
    expect(DE.usage_ai_explain_own).toMatch(/\bIhre\b/);
  });

  it("write a range of rows with a dash between its numbers only", () => {
    expect(EN.usage_range_text).toBe("{{from}}–{{to}} of {{total}} {{noun}}");
    expect(DE.usage_range_text).toBe("{{from}}–{{to}} von {{total}} {{noun}}");
    expect([EN.usage_range_span, DE.usage_range_span]).toEqual(["{{from}} to {{to}}", "{{from}} bis {{to}}"]);
  });

  it("name the storage tile and the tiles in plain words", () => {
    // The shared `storage` reads "Speicherlimit" elsewhere; the tile names what is used.
    expect([EN.usage_tile_storage, DE.usage_tile_storage]).toEqual(["Storage", "Speicher"]);
    expect([EN.usage_quotas, DE.usage_quotas]).toEqual(["Quotas", "Kontingente"]);
  });

  it("use the agreed words for AI credits and their dates", () => {
    expect([EN.usage_ai_credits, DE.usage_ai_credits]).toEqual(["AI credits", "KI-Credits"]);
    expect([EN.resets_on, DE.resets_on]).toEqual(["Resets on", "Neu ab"]);
    expect([EN.valid_until, DE.valid_until]).toEqual(["Valid until", "Gültig bis"]);
    expect([EN.public_traffic, DE.public_traffic]).toEqual(["Public pages", "Öffentliche Seiten"]);
  });

  it("charge each answer, call admins Admins and label in sentence case", () => {
    expect(EN.usage_ai_explain_rule).toMatch(/^Each answer of GOAT AI uses\b/);
    expect(DE.usage_ai_explain_rule).toMatch(/^Jede Antwort von GOAT AI verbraucht\b/);
    expect([EN.usage_role_admins, DE.usage_role_admins]).toEqual([
      "Owners and admins",
      "Eigentümer und Admins",
    ]);
    // A member's role reads as the tiles name the seats (roleWords, as every settings page).
    expect(
      ["organization-owner", "organization-admin", "organization-editor", "organization-viewer"].map(
        (key) => DE[key]
      )
    ).toEqual(["Eigentümer", "Admin", "Bearbeiter", "Betrachter"]);
    expect(EN.group_by).toBe("Group by");
    // The layers' column carries credits, and says so.
    expect([EN.usage_traffic_credits, DE.usage_traffic_credits]).toEqual([
      "Traffic credits",
      "Credits Traffic",
    ]);
  });

  it("call the page Usage and say who sees it", () => {
    expect([EN.usage_and_quotas, DE.usage_and_quotas]).toEqual(["Usage", "Nutzung"]);
    expect(EN.usage_admins_only).toBe("Only owners and admins see this page.");
    expect(DE.usage_admins_only).toBe("Nur Eigentümer und Admins sehen diese Seite.");
  });

  it("count rows in German in the dative and name none in the nominative", () => {
    const t = commonT("de");
    expect(
      t("usage_range_text", { from: 1, to: 10, total: 23, noun: t("usage_noun_tools", { count: 23 }) })
    ).toBe("1–10 von 23 Werkzeugen");
    expect(t("usage_none", { noun: t("usage_noun_tools", { count: 0 }) })).toBe("Keine Werkzeuge");
    for (const key of NOUN_KEYS) expect(DE[`${key}_zero`], key).toBeTruthy();
  });

  it("drop the texts the page no longer shows", () => {
    for (const key of [
      "usage_and_quotas_information",
      "credit_pricing_ai",
      "trial_credits_until",
      "usage_activity",
      "usage_activity_description",
      "compute_this_period",
      "traffic_this_period",
      "current_storage_out_of_total_quota",
      "current_projects_out_of_total_quota",
      "out_of",
      "remaining",
      // The Overview and Activity tabs the quota tiles replaced.
      "usage_overview",
      "credit_budget",
      "credit_pricing_title",
      "credit_pricing_ai_rule",
      "credits_remaining",
      "storage_quota_information",
      "group_by_service_type",
      "no_activity_data",
      "usage_entries_note",
      "usage_quota_of",
      "usage_ai_used_up",
      "usage_service_tiles",
      "usage_steps_one",
      "usage_ai_per_editor_one",
      "ledger",
      "capacity",
      "compute",
      "date",
      "overview",
      "key",
      "action",
      "unit_type",
      "group_by_category",
      "group_by_service",
      "group_by_project",
      "hours_abbr",
      "minutes_abbr",
      "seconds_abbr",
      "gb_abbr",
    ]) {
      expect(EN[key], key).toBeUndefined();
      expect(DE[key], key).toBeUndefined();
    }
  });
});
