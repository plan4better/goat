/**
 * Values written into an edit's SQL. An edit's statements are kept as text
 * (the session replays none of them, but the tests and the change read
 * them), so a value a user typed goes in as a quoted literal.
 */

/** A text literal, or NULL. */
export function sqlText(value: string | null | undefined): string {
  return value === null || value === undefined ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

/** A number literal, or NULL; never anything else. */
export function sqlNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (!Number.isFinite(value)) throw new Error(`Not a number: ${value}`);
  return String(value);
}
