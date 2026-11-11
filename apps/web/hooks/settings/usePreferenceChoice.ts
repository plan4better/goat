"use client";

import type { PaletteMode } from "@mui/material";
import { useTheme } from "@mui/material";
import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { updateSystemSettings } from "@/lib/api/system/client";

import { ColorModeContext } from "@/components/@mui/ThemeRegistry";

export type PreferenceLanguage = "de" | "en";
export interface PreferenceChoice {
  language: PreferenceLanguage;
  mode: PaletteMode;
}

/**
 * The caller's language and appearance, and how a pick is saved: system
 * settings, then the preference cookie, then the UI follows, which shows it
 * saved; a failure puts the previous choice back. A second pick while one
 * saves is dropped, so it cannot overtake it. Settings and the account menu
 * both pick here; a pick in one shows in the other, as both follow the UI.
 */
export function usePreferenceChoice(): {
  choice: PreferenceChoice;
  saving: boolean;
  save: (next: PreferenceChoice) => Promise<void>;
} {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const { changeColorMode } = useContext(ColorModeContext);
  const language: PreferenceLanguage = i18n.language?.startsWith("de") ? "de" : "en";
  const mode = theme.palette.mode;
  const [choice, setChoice] = useState<PreferenceChoice>({ language, mode });
  const [saving, setSaving] = useState(false);

  // A pick made elsewhere (the account menu, while settings is open).
  useEffect(() => {
    setChoice({ language, mode });
  }, [language, mode]);

  const save = async (next: PreferenceChoice) => {
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
      if (next.language !== previous.language) await i18n.changeLanguage(next.language);
      else changeColorMode(next.mode);
    } catch {
      setChoice(previous);
      toast.error(t("settings_prefs_error"));
    } finally {
      setSaving(false);
    }
  };

  return { choice, saving, save };
}
