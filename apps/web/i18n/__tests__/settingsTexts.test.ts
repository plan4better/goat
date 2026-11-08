import { describe, expect, it } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import { commonT } from "./commonI18n";

const EN = en as unknown as Record<string, string>;
const DE = de as unknown as Record<string, string>;

const isSettingsKey = (key: string) => key.startsWith("settings_") || key.startsWith("role_description_");
const EN_KEYS = Object.keys(EN).filter(isSettingsKey).sort();
const DE_KEYS = Object.keys(DE).filter(isSettingsKey).sort();
const placeholders = (text: string) =>
  [...text.matchAll(/{{\s*(\w+)[^}]*}}|<(\w+)>/g)].map((m) => m[1] ?? m[2]).sort();

describe("settings texts", () => {
  it("are there, in both languages, with the same keys and placeholders", () => {
    expect(EN_KEYS.length).toBeGreaterThan(300);
    expect(DE_KEYS).toEqual(EN_KEYS);
    for (const key of EN_KEYS) {
      expect(EN[key], key).toBeTruthy();
      expect(DE[key], key).toBeTruthy();
      expect(placeholders(DE[key]), key).toEqual(placeholders(EN[key]));
    }
  });

  it("use no dash inside a sentence and address the reader as Sie", () => {
    for (const key of EN_KEYS) {
      expect(EN[key], key).not.toMatch(/[—–]/);
      expect(DE[key], key).not.toMatch(/[—–]/);
      expect(DE[key], key).not.toMatch(/\b(du|dich|dir|dein\w*)\b/i);
    }
  });

  it("name the four roles with one set of words wherever a role is named", () => {
    const de4 = ["Eigentümer", "Admin", "Bearbeiter", "Betrachter"];
    const en4 = ["Owner", "Admin", "Editor", "Viewer"];
    for (const keys of [
      ["organization-owner", "organization-admin", "organization-editor", "organization-viewer"],
      ["owner", "admin", "editor", "viewer"],
    ]) {
      expect(keys.map((key) => DE[key])).toEqual(de4);
      expect(keys.map((key) => EN[key])).toEqual(en4);
    }
    expect([DE.usage_role_admins, DE.usage_admins_only]).toEqual([
      "Eigentümer und Admins",
      "Nur Eigentümer und Admins sehen diese Seite.",
    ]);
    expect([DE.usage_all_owners, DE.usage_owner_chip, DE.usage_owner_removed]).toEqual([
      "Alle Eigentümer",
      "Eigentümer: {{name}}",
      "Eigentümer entfernt",
    ]);
  });

  it("drop the old words from the texts that named them", () => {
    for (const key of [
      "ai_settings_admin_only",
      "assistant_credits_admins_manage",
      "assistant_credits_ask_admin",
      "template_shares_datasets_note_one",
      "template_shares_datasets_note_other",
    ]) {
      expect(DE[key], key).not.toMatch(/Administrator|Besitzer|Leserecht|\bViewer\b|\bEditor\b/);
    }
  });

  it("drop the texts of the settings pages the rebuild replaced", () => {
    const replaced = /^(white_label_|ai_settings_nav$|usage_role_(owner|admin|editor|viewer)$)/;
    expect(Object.keys(EN).filter((key) => replaced.test(key))).toEqual([]);
    expect(Object.keys(DE).filter((key) => replaced.test(key))).toEqual([]);
    for (const key of [
      // The two that still named the old role words ("Editoren", "Administrator(en)").
      "editors_quota_label",
      "delete_account_confirmation_body",
      // The domain card's old detail line ("Zertifikat: ...").
      "settings_domains_cert_line",
    ]) {
      expect(EN[key], key).toBeUndefined();
      expect(DE[key], key).toBeUndefined();
    }
  });

  it("resolve the counted settings texts in both forms", () => {
    for (const language of ["en", "de"] as const) {
      const t = commonT(language);
      for (const key of [
        "settings_org_member_count",
        "settings_teams_member_count",
        "settings_domains_count",
        "settings_analytics_measures",
        "settings_analytics_remove_used",
        "settings_org_delete_point_members",
        "settings_members_invalid",
        "settings_members_known",
        "settings_members_editors_full_callout",
        "settings_members_viewers_full_callout",
      ]) {
        for (const count of [1, 3]) expect(t(key, { count }), `${language} ${key}`).not.toBe(key);
      }
    }
  });

  it("say a full pool of one seat in the singular", () => {
    const expected = {
      en: {
        settings_members_editors_full_callout: [
          "The only editor seat is taken. You can invite new people as viewers. To free an editor seat, change a member's role or remove someone.",
          "All 5 editor seats are taken. You can invite new people as viewers. To free an editor seat, change a member's role or remove someone.",
        ],
        settings_members_viewers_full_callout: [
          "The only viewer seat is taken. To free a viewer seat, remove someone or withdraw an invitation.",
          "All 5 viewer seats are taken. To free a viewer seat, remove someone or withdraw an invitation.",
        ],
      },
      de: {
        settings_members_editors_full_callout: [
          "Der einzige Bearbeiter-Platz ist belegt. Neue Personen können Sie als Betrachter einladen. Einen Bearbeiter-Platz geben Sie frei, indem Sie die Rolle eines Mitglieds ändern oder jemanden entfernen.",
          "Alle 5 Bearbeiter-Plätze sind belegt. Neue Personen können Sie als Betrachter einladen. Einen Bearbeiter-Platz geben Sie frei, indem Sie die Rolle eines Mitglieds ändern oder jemanden entfernen.",
        ],
        settings_members_viewers_full_callout: [
          "Der einzige Betrachter-Platz ist belegt. Einen Betrachter-Platz geben Sie frei, indem Sie jemanden entfernen oder eine Einladung zurückziehen.",
          "Alle 5 Betrachter-Plätze sind belegt. Einen Betrachter-Platz geben Sie frei, indem Sie jemanden entfernen oder eine Einladung zurückziehen.",
        ],
      },
    };
    for (const language of ["en", "de"] as const) {
      const t = commonT(language);
      for (const key of [
        "settings_members_editors_full_callout",
        "settings_members_viewers_full_callout",
      ] as const) {
        expect(
          [1, 5].map((count) => t(key, { count })),
          `${language} ${key}`
        ).toEqual(expected[language][key]);
        // Only the counted forms: the bare key would read "All 1 editor seats".
        expect(EN[key], key).toBeUndefined();
        expect(DE[key], key).toBeUndefined();
      }
    }
  });

  it("count the free seats and the people outside a team, so that none and one read right", () => {
    const seats = [
      { count: 0, people: 2 },
      { count: 1, people: 2 },
      { count: 3, people: 5 },
    ];
    const expected = {
      en: {
        settings_members_too_few_editor_seats: [
          "No editor seat is free.",
          "Only one editor seat is free for 2 invitations.",
          "Only 3 editor seats are free for 5 invitations.",
        ],
        settings_members_too_few_viewer_seats: [
          "No viewer seat is free.",
          "Only one viewer seat is free for 2 invitations.",
          "Only 3 viewer seats are free for 5 invitations.",
        ],
        settings_team_add_outside: [
          "1 person of the organization not in the team",
          "3 people of the organization not in the team",
        ],
      },
      de: {
        settings_members_too_few_editor_seats: [
          "Kein Bearbeiter-Platz ist frei.",
          "Für 2 Einladungen ist nur ein Bearbeiter-Platz frei.",
          "Für 5 Einladungen sind nur 3 Bearbeiter-Plätze frei.",
        ],
        settings_members_too_few_viewer_seats: [
          "Kein Betrachter-Platz ist frei.",
          "Für 2 Einladungen ist nur ein Betrachter-Platz frei.",
          "Für 5 Einladungen sind nur 3 Betrachter-Plätze frei.",
        ],
        settings_team_add_outside: [
          "1 Person der Organisation nicht im Team",
          "3 Personen der Organisation nicht im Team",
        ],
      },
    };
    for (const language of ["en", "de"] as const) {
      const t = commonT(language);
      const texts = expected[language];
      for (const key of [
        "settings_members_too_few_editor_seats",
        "settings_members_too_few_viewer_seats",
      ] as const) {
        expect(
          seats.map((values) => t(key, values)),
          `${language} ${key}`
        ).toEqual(texts[key]);
      }
      expect([1, 3].map((count) => t("settings_team_add_outside", { count }))).toEqual(
        texts.settings_team_add_outside
      );
    }
    for (const key of [
      "settings_members_too_few_editor_seats",
      "settings_members_too_few_viewer_seats",
      "settings_team_add_outside",
    ]) {
      // Only the counted forms: the bare key would read "1 people".
      expect(EN[key], key).toBeUndefined();
      expect(DE[key], key).toBeUndefined();
    }
  });

  it("write the certificate's state in lower case, as it follows its label", () => {
    expect([DE.settings_domains_detail_cert, DE.settings_domains_detail_cert_value]).toEqual([
      "Zertifikat",
      "gültig, erneuert sich selbst",
    ]);
  });
});
