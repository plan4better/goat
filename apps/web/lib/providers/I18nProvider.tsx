"use client";

import i18next from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import resourcesToBackend from "i18next-resources-to-backend";
import React, { useMemo } from "react";
import { I18nextProvider as Provider, initReactI18next } from "react-i18next";

import { getOptions, languages } from "@/i18n/settings";

import { LANGUAGE_COOKIE_NAME } from "@/lib/constants";

const runsOnServerSide = typeof window === "undefined";

i18next
  .use(initReactI18next)
  .use(LanguageDetector)
  .use(
    resourcesToBackend(
      (language: string, namespace: string) => import(`@/i18n/locales/${language}/${namespace}.json`)
    )
  )
  .init({
    ...getOptions(),
    detection: {
      // cookie first; ignore path/navigator
      order: ["cookie", "htmlTag"],
      // Never cache the detected language: before sign-in that is the fallback, and
      // as a cookie it would beat the user's own language right after sign-in. The
      // cookie is written only when the user picks a language (/api/preferences/update).
      caches: [],
      lookupCookie: LANGUAGE_COOKIE_NAME,
    },
    preload: runsOnServerSide ? languages : [],
  });

export function I18nProvider({ children, language }) {
  useMemo(() => {
    i18next.changeLanguage(language);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Provider i18n={i18next}>{children}</Provider>;
}
