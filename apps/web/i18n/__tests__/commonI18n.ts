import i18next, { type TFunction, type i18n } from "i18next";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

/**
 * A real i18next instance over the app's `common` texts, for tests that need
 * what i18next resolves at run time: plural, zero and context forms, and the
 * default value of a missing key.
 */
export const commonI18n = (language: "en" | "de"): i18n => {
  const instance = i18next.createInstance();
  void instance.init({
    lng: language,
    fallbackLng: false,
    ns: ["common"],
    defaultNS: "common",
    resources: { en: { common: en }, de: { common: de } },
    initImmediate: false,
  });
  return instance;
};

/** The `t` of {@link commonI18n}, fixed to the language. */
export const commonT = (language: "en" | "de"): TFunction =>
  commonI18n(language).getFixedT(language, "common");
