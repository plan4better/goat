// The app's own words for the legend tests: `t` reads the real locale files, so a key the legend uses and the
// files lack shows as the raw key, as it would in the app.
import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

const WORDS: Record<string, unknown> = { en, de };

/** The language the mocked `useTranslation` answers in; tests set it before rendering. */
export const language = { current: "en" };

function lookup(lang: string, key: string): unknown {
  let node: unknown = WORDS[lang];
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

export function translate(lang: string) {
  return (key: string, options?: Record<string, unknown>): string => {
    const count = options?.count;
    const found =
      (typeof count === "number" ? lookup(lang, `${key}_${count === 1 ? "one" : "other"}`) : undefined) ??
      lookup(lang, key);
    if (typeof found !== "string") return key;
    return found.replace(/{{\s*(\w+)\s*}}/g, (_, name: string) => String(options?.[name] ?? ""));
  };
}

/** What `vi.mock("react-i18next", ...)` returns in the legend tests. */
export const reactI18nextMock = {
  useTranslation: () => ({ t: translate(language.current), i18n: { language: language.current } }),
};
