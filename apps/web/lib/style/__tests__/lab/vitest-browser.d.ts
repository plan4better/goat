// The browser API of the lab's tests (`page`, `commands`). TypeScript resolves packages here without their `exports`
// (moduleResolution "node"), so it does not find `vitest/browser`, which Vite resolves through them at run time; this
// points the types at the file that holds them.
declare module "vitest/browser" {
  export * from "vitest/browser/context";
}
