// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENTRYPOINT = path.resolve(__dirname, "../../entrypoint.sh");
/** Placeholders, and the bare prefix `publicEnv` compares values against. */
const BUNDLE =
  'x="APP_NEXT_PUBLIC_API_URL";y="APP_NEXT_PUBLIC_MAPBOX_TOKEN";z="APP_NEXT_PUBLIC_API_URL_V2";' +
  'p=v.startsWith("APP_NEXT_PUBLIC_")';

/** Applets the entrypoint calls, linked to busybox so a run sees the same
 * sed/tar/grep semantics as the node:alpine image. */
const BUSYBOX_APPLETS = ["sh", "sed", "tar", "grep", "env", "sort", "cut", "awk", "cat", "true", "echo"];
const BUSYBOX = ["/bin/busybox", "/usr/bin/busybox"].find((candidate) => existsSync(candidate));

type Shell = { name: string; command: string; path: string };

const shells = (): Shell[] => {
  const list: Shell[] = [{ name: "sh", command: "sh", path: "/usr/local/bin:/usr/bin:/bin" }];
  if (BUSYBOX) list.push({ name: "busybox sh", command: "sh", path: "" });
  return list;
};

describe.each(shells())("entrypoint.sh under $name", (shell) => {
  let webDir: string;
  let binDir: string;

  const bundle = () => readFileSync(path.join(webDir, ".next/static/a.js"), "utf8");

  const run = (env: Record<string, string>, args: string[] = ["true"]) =>
    execFileSync(shell.command, [ENTRYPOINT, ...args], {
      // A clean env: only what the test sets reaches the script.
      env: { NODE_ENV: "test", PATH: shell.path || binDir, WEB_DIR: webDir, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  const writeBundle = () => {
    mkdirSync(path.join(webDir, ".next/static"), { recursive: true });
    writeFileSync(path.join(webDir, ".next/static/a.js"), BUNDLE);
    writeFileSync(path.join(webDir, ".next/static/plain.js"), 'w="no placeholder"');
  };

  beforeEach(() => {
    webDir = mkdtempSync(path.join(tmpdir(), "goat-web-"));
    binDir = path.join(webDir, "bin");
    if (BUSYBOX) {
      mkdirSync(binDir);
      for (const applet of BUSYBOX_APPLETS) symlinkSync(BUSYBOX, path.join(binDir, applet));
    }
    writeBundle();
    execFileSync("tar", ["-cf", ".next-templates.tar", ".next/static/a.js"], { cwd: webDir });
  });

  afterEach(() => {
    rmSync(webDir, { recursive: true, force: true });
  });

  it("substitutes values carrying sed and shell metacharacters verbatim", () => {
    const value = "https://h.test/a?b=1&c=2#frag|x\\y z";
    run({ NEXT_PUBLIC_API_URL: value });
    expect(bundle()).toContain(`x="${value}";`);
  });

  it("re-applies from the pristine copy on every start", () => {
    run({ NEXT_PUBLIC_API_URL: "https://old.test" });
    run({ NEXT_PUBLIC_API_URL: "https://new.test" });
    expect(bundle()).toContain('x="https://new.test";');
    expect(bundle()).not.toContain("old.test");
  });

  it("leaves the placeholder of an unset variable empty", () => {
    run({ NEXT_PUBLIC_API_URL: "https://h.test" });
    expect(bundle()).toContain('y="";');
  });

  it("leaves no placeholder behind when nothing is set, and logs each one it clears", () => {
    const out = run({});
    expect(bundle()).toBe('x="";y="";z="";p=v.startsWith("APP_NEXT_PUBLIC_")');
    expect(out.split("\n").filter((line) => line.startsWith("Clearing "))).toEqual([
      "Clearing APP_NEXT_PUBLIC_API_URL",
      "Clearing APP_NEXT_PUBLIC_API_URL_V2",
      "Clearing APP_NEXT_PUBLIC_MAPBOX_TOKEN",
    ]);
  });

  it("replaces a name that extends another as a whole", () => {
    run({ NEXT_PUBLIC_API_URL: "https://one.test", NEXT_PUBLIC_API_URL_V2: "https://two.test" });
    expect(bundle()).toContain('x="https://one.test";');
    expect(bundle()).toContain('z="https://two.test"');
  });

  it("logs the names it sets, never the values", () => {
    const out = run({ NEXT_PUBLIC_API_URL: "https://h.test", NEXT_PUBLIC_MAPBOX_TOKEN: "pk.secret" });
    expect(out).toContain("NEXT_PUBLIC_MAPBOX_TOKEN");
    expect(out).not.toContain("pk.secret");
    expect(bundle()).toContain('y="pk.secret"');
  });

  it("substitutes in place when the image carries no pristine copy", () => {
    rmSync(path.join(webDir, ".next-templates.tar"));
    run({ NEXT_PUBLIC_API_URL: "https://h.test" });
    expect(bundle()).toContain('x="https://h.test";');
  });

  it.each(["NEXT_PUBLIC_TERRAIN_TILES_URL", "NEXT_PUBLIC_BUILDINGS_TILES_URL"])(
    "%s: the container's value, empty when set empty (off), the bare prefix when unset (the app's default)",
    (name) => {
      writeFileSync(path.join(webDir, ".next/static/a.js"), `t="APP_${name}";u="APP_NEXT_PUBLIC_API_URL"`);
      execFileSync("tar", ["-cf", ".next-templates.tar", ".next/static/a.js"], { cwd: webDir });
      run({ [name]: "https://tiles.example.org/{z}/{x}/{y}.webp" });
      expect(bundle()).toBe('t="https://tiles.example.org/{z}/{x}/{y}.webp";u=""');
      run({ [name]: "" });
      expect(bundle()).toBe('t="";u=""');
      // Unset: `publicEnv` reads the bare prefix as "not set", so the app falls back to its default; every other
      // unset variable is still cleared to empty.
      run({});
      expect(bundle()).toBe('t="APP_NEXT_PUBLIC_";u=""');
    }
  );

  it("runs the given command", () => {
    const out = run({}, ["echo", "started"]);
    expect(out.trim().split("\n").pop()).toBe("started");
  });
});

describe("Dockerfile", () => {
  // The image is built with a placeholder for every NEXT_PUBLIC_ value the app reads at run time; a value without
  // one is fixed at build time and the container's setting never reaches the browser.
  it.each(["NEXT_PUBLIC_TERRAIN_TILES_URL", "NEXT_PUBLIC_BUILDINGS_TILES_URL"])(
    "builds %s as a placeholder the entrypoint replaces",
    (name) => {
      const dockerfile = readFileSync(path.resolve(__dirname, "../../Dockerfile"), "utf8");
      expect(dockerfile).toContain(`ARG ${name}=APP_${name}\n`);
    }
  );
});

/** What the bundle is compiled from: the entrypoint rewrites all of it. */
const APP_SOURCES = ["app", "components", "hooks", "lib", "middlewares"];
const FULL_PLACEHOLDER_LITERAL = /(["'`])APP_NEXT_PUBLIC_[A-Za-z0-9_]+\1/;

describe("app source", () => {
  // A full placeholder name in the source is rewritten with the value too, so
  // a comparison against it always matches once the variable is set. Tell the
  // placeholder apart by its bare prefix instead (`publicEnv`).
  it("spells no full placeholder name, which the entrypoint would rewrite", () => {
    const webDir = path.resolve(__dirname, "../..");
    const offenders = APP_SOURCES.flatMap((dir) =>
      readdirSync(path.join(webDir, dir), { recursive: true, encoding: "utf8" })
        .filter((file) => /\.(ts|tsx|js|mjs)$/.test(file) && !/(^|\/)__tests__\//.test(file))
        .map((file) => path.join(dir, file))
    ).filter((file) => FULL_PLACEHOLDER_LITERAL.test(readFileSync(path.join(webDir, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
