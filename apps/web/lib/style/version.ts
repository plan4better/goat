// GOAT Style versions (spec 14): three numbers, "1.0.0"; the integer 1 of documents written before is read as 1.0.0.
// Layer styles and the map document share one version.
import { type JsonObject, isObject } from "@/lib/style/json";

/** The version the web writes on a document it creates. A document read keeps its version when it is sent back; the
 * server stamps the lowest version a saved document needs. */
export const STYLE_VERSION = "1.0.0";

/** Major 1 as goatlib reads a version: three numbers without leading zeros. */
const MAJOR_ONE = /^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Whether the web draws a document: an object of major 1, as "1.x.y" or the integer 1. A document of another major,
 * or with a malformed version, is one the web does not know: the caller draws its fallback. */
export const isDrawableStyle = (value: unknown): value is JsonObject =>
  isObject(value) &&
  (value.version === 1 || (typeof value.version === "string" && MAJOR_ONE.test(value.version)));
