"use client";

import type { PaletteMode } from "@mui/material";
import { Box, useTheme } from "@mui/material";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { updateSystemSettings } from "@/lib/api/system/client";

import { ColorModeContext } from "@/components/@mui/ThemeRegistry";
import RadioCardGroup from "@/components/settings/common/RadioCardGroup";
import SettingsCard from "@/components/settings/common/SettingsCard";

type Language = "de" | "en";
interface Choice {
  language: Language;
  mode: PaletteMode;
}

const Badge = ({ children }: { children: string }) => (
  <Box
    component="span"
    aria-hidden
    sx={{
      px: 1.5,
      py: "2px",
      borderRadius: "6px",
      border: 1,
      borderColor: "divider",
      fontSize: 11,
      fontWeight: 800,
    }}>
    {children}
  </Box>
);

/** A small drawing of the app in a mode: a header, a nav column, two cards. */
const ModePreview = ({ mode }: { mode: PaletteMode }) => {
  const dark = mode === "dark";
  const page = dark ? "#18202B" : "#F4F6F8";
  const surface = dark ? "#222C38" : "#FFFFFF";
  const line = dark ? "#3A4655" : "#DDE2E8";
  return (
    <Box
      aria-hidden
      sx={{
        width: 64,
        height: 44,
        flexShrink: 0,
        borderRadius: "6px",
        border: `1px solid ${line}`,
        backgroundColor: page,
        overflow: "hidden",
      }}>
      <Box sx={{ height: 8, backgroundColor: surface, borderBottom: `1px solid ${line}` }} />
      <Box sx={{ display: "flex", gap: "4px", p: "4px" }}>
        <Box sx={{ width: 12, height: 24, borderRadius: "3px", backgroundColor: surface }} />
        <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
          <Box sx={{ height: 10, borderRadius: "3px", backgroundColor: surface }} />
          <Box sx={{ height: 10, borderRadius: "3px", backgroundColor: surface }} />
        </Box>
      </Box>
    </Box>
  );
};

/**
 * Sprache and Erscheinungsbild: a pick saves at once (system settings, then
 * the preference cookie, then the UI follows) and says so in the new
 * language; a failure puts the previous card back. While a pick saves, the
 * other cards are disabled, so a second pick cannot overtake it.
 */
export default function PreferenceCards() {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const { changeColorMode } = useContext(ColorModeContext);
  const [choice, setChoice] = useState<Choice>({
    language: i18n.language?.startsWith("de") ? "de" : "en",
    mode: theme.palette.mode,
  });
  const [saving, setSaving] = useState(false);

  const save = async (next: Choice) => {
    if (saving) return;
    const previous = choice;
    setChoice(next);
    setSaving(true);
    try {
      const saved = await updateSystemSettings({
        preferred_language: next.language,
        client_theme: next.mode,
        unit: "metric",
      });
      if (!saved) throw new Error("no settings returned");
      const cookie = await fetch("/api/preferences/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: saved.preferred_language, theme: saved.client_theme }),
      });
      if (!cookie.ok) throw new Error("preference cookie not set");
      if (next.language !== previous.language) {
        await i18n.changeLanguage(next.language);
        toast.success(i18n.getFixedT(next.language, "common")("settings_prefs_saved"));
      } else {
        changeColorMode(next.mode);
        toast.success(
          t("settings_prefs_theme_saved", {
            theme: t(next.mode === "dark" ? "settings_prefs_dark" : "settings_prefs_light"),
          })
        );
      }
    } catch {
      setChoice(previous);
      toast.error(t("settings_prefs_error"));
    } finally {
      setSaving(false);
    }
  };

  // The picked card stays enabled (picking it again changes nothing).
  const held = (value: string, current: string) => saving && value !== current;

  return (
    <>
      <SettingsCard title={t("settings_prefs_language_title")} hint={t("settings_prefs_language_hint")}>
        <RadioCardGroup<Language>
          label={t("settings_prefs_language_title")}
          value={choice.language}
          columns={{ xs: 1, md: 2 }}
          onChange={(language) => language !== choice.language && void save({ ...choice, language })}
          options={[
            {
              value: "de",
              label: "Deutsch",
              line: t("settings_prefs_line_de"),
              lead: <Badge>DE</Badge>,
              lang: "de",
              disabled: held("de", choice.language),
            },
            {
              value: "en",
              label: "English",
              line: t("settings_prefs_line_en"),
              lead: <Badge>EN</Badge>,
              lang: "en",
              disabled: held("en", choice.language),
            },
          ]}
        />
      </SettingsCard>
      <SettingsCard title={t("settings_prefs_appearance_title")} hint={t("settings_prefs_appearance_hint")}>
        <RadioCardGroup<PaletteMode>
          label={t("settings_prefs_appearance_title")}
          value={choice.mode}
          columns={{ xs: 1, md: 2 }}
          onChange={(mode) => mode !== choice.mode && void save({ ...choice, mode })}
          options={[
            {
              value: "light",
              label: t("settings_prefs_light"),
              lead: <ModePreview mode="light" />,
              disabled: held("light", choice.mode),
            },
            {
              value: "dark",
              label: t("settings_prefs_dark"),
              lead: <ModePreview mode="dark" />,
              disabled: held("dark", choice.mode),
            },
          ]}
        />
      </SettingsCard>
    </>
  );
}
