import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { FILTER_LIMITS, FILTER_OPERATORS } from "@/lib/filter/generated/operators";

const WEB = resolve(__dirname, "../../..");

type Generated = { files: Record<string, string>; formatted: Record<string, boolean> };

/** The generator's filter output and whether prettier leaves it as generated, from a plain Node process (see
 * lib/style/__tests__/generated.test.ts for why). */
const generateInNode = (): Generated => {
  const script = pathToFileURL(resolve(WEB, "scripts/generate-style-sources.mjs")).href;
  const program = `
    import { check, resolveConfig } from "prettier";
    import { resolve } from "node:path";
    const { generateFilter } = await import(${JSON.stringify(script)});
    const files = await generateFilter();
    const formatted = {};
    for (const [path, content] of Object.entries(files)) {
      const filepath = resolve(${JSON.stringify(WEB)}, path);
      formatted[path] = await check(content, { ...(await resolveConfig(filepath)), filepath });
    }
    process.stdout.write(JSON.stringify({ files, formatted }));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", program], { cwd: WEB, encoding: "utf8" })
  ) as Generated;
};

describe("generated filter sources", () => {
  it("are current and formatted like the rest of the repository", () => {
    const { files, formatted } = generateInNode();
    expect(Object.keys(files)).toEqual(["lib/filter/generated/operators.ts"]);
    for (const [path, content] of Object.entries(files)) {
      expect(readFileSync(resolve(WEB, path), "utf8"), path).toBe(content);
      expect(formatted[path], path).toBe(true);
    }
  });

  it("carry goatlib's limits and operators", () => {
    expect(FILTER_LIMITS.conditions).toBe(20);
    expect(FILTER_LIMITS.values).toBe(100);
    expect(FILTER_OPERATORS.boolean).toEqual(["is_true", "is_false", "is_blank", "is_not_blank"]);
  });
});
