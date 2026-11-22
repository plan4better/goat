// i18next writes interpolated values as HTML entities unless told otherwise. The style editor prints its texts as
// React text, which React escapes itself, or sends them to the server, so the names it puts into a text (field,
// style, layer and icon names, typed searches, translated words) go in as they are: `t(key, { name, ...PLAIN })`.
export const PLAIN = { interpolation: { escapeValue: false } } as const;
