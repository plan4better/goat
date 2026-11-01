import "@testing-library/jest-dom";
import { cleanup } from "@testing-library/react";
import * as webStreams from "node:stream/web";
import { afterEach, vi } from "vitest";

// The VM pools (CI runs --pool=vmForks) evaluate each test file inside
// jsdom's own window, into which vitest copies only a fixed list of Node
// globals: fetch, Response and the like, but none of the web streams. The
// `ai` SDK's eventsource-parser subclasses TransformStream at import time, so
// without them every suite reaching it fails to load. The missing classes
// come from node:stream/web, the realm whose streams the copied Response
// bodies already are, so piping a fetched body through them keeps working.
// Under the default pool they are present and left alone.
const testGlobals = globalThis as Record<string, unknown>;
for (const name of [
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextEncoderStream",
  "TextDecoderStream",
] as const) {
  if (typeof testGlobals[name] === "undefined") testGlobals[name] = webStreams[name];
}

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// jsdom's CSS parser does not know `@container`, so every render of a
// component that carries a container query raises "Could not parse CSS
// stylesheet" through the virtual console. The rules are valid and are what
// ships; only parsing them here is unsupported, so that one message is
// dropped and every other error still prints.
const printError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  const message = first instanceof Error ? first.message : String(first ?? "");
  if (message.includes("Could not parse CSS stylesheet")) return;
  printError(...args);
};

// Mock Next.js router
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    pathname: "/",
    query: {},
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

// Mock environment variables
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
// lib/api/* build their base URLs at import time, so anything importing them
// needs these present before the module graph is evaluated.
process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
process.env.NEXT_PUBLIC_GEOAPI_URL = "http://localhost:8100";
process.env.NEXT_PUBLIC_PROCESSES_URL = "http://localhost:8300";

// next/dynamic, as a React.lazy component: the chunk still lands a tick
// after the first render, as in the app, without Next's runtime (whose CJS
// build pulls @swc/helpers in a way VM-based pools cannot load).
vi.mock("next/dynamic", async () => {
  const React = await import("react");
  type Loaded =
    | { default?: React.ComponentType<Record<string, unknown>> }
    | React.ComponentType<Record<string, unknown>>;
  return {
    default: (
      load: () => Promise<Loaded>,
      options?: { loading?: React.ComponentType<Record<string, unknown>> }
    ) => {
      const Lazy = React.lazy(async () => {
        const loaded = await load();
        return {
          default:
            typeof loaded === "function"
              ? loaded
              : (loaded.default as React.ComponentType<Record<string, unknown>>),
        };
      });
      const Loading = options?.loading;
      const Dynamic = (props: Record<string, unknown>) =>
        React.createElement(
          React.Suspense,
          { fallback: Loading ? React.createElement(Loading) : null },
          React.createElement(Lazy, props)
        );
      return Dynamic;
    },
  };
});
