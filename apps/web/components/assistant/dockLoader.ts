import { useEffect, useSyncExternalStore } from "react";

import { warmConversations } from "@/lib/assistant/conversations";
import { getActiveSurface, getDockState } from "@/lib/assistant/store";

type AssistantDockComponent = typeof import("@/components/assistant/AssistantDock").default;

/** An idle callback runs at the latest this long after it was asked for. */
const IDLE_TIMEOUT_MS = 2000;

let dock: AssistantDockComponent | null = null;
let loading: Promise<void> | null = null;
/** The last load failed: the dock's frame says so and offers to try again. */
let failed = false;
/** Loads that failed in a row: after a deploy the old code is gone, and only a reload helps. */
let failures = 0;
/** The conversation lists read ahead on this page: null for the full history, else a project's id. */
const warmed = new Set<string | null>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/**
 * Loads the dock's code, once (again after a failed load, which a dock that
 * opens or its frame's "Try again" asks for). A plain import and
 * not `next/dynamic`: a lazy component suspends on its first render even when
 * its code is in, and React then holds the dock back for a moment after showing
 * the fallback, so a prefetched dock would still open late. Client only: the
 * condition drops the import from the server build.
 */
export function loadAssistantDock(): Promise<void> {
  if (typeof window !== "undefined" && !dock && !loading) {
    if (failed) {
      failed = false;
      notify();
    }
    loading = import("@/components/assistant/AssistantDock").then(
      (module) => {
        dock = module.default;
        loading = null;
        failures = 0;
        notify();
      },
      () => {
        loading = null;
        failed = true;
        failures += 1;
        notify();
      }
    );
  }
  return loading ?? Promise.resolve();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** How many loads of the dock's code failed in a row; 0 unless the last one failed. */
export const useAssistantDockFailures = (): number =>
  useSyncExternalStore(
    subscribe,
    () => (failed ? failures : 0),
    () => 0
  );

/** The dock's component once its code is in, else null while it loads. */
export function useAssistantDock(): AssistantDockComponent | null {
  const loaded = useSyncExternalStore(
    subscribe,
    () => dock,
    () => null
  );
  useEffect(() => {
    if (!loaded) void loadAssistantDock();
  }, [loaded]);
  return loaded;
}

/** Reads one conversation list ahead, once per page. */
function warm(projectId: string | null): void {
  if (warmed.has(projectId)) return;
  warmed.add(projectId);
  // The dock reads its lists again whenever it opens, and a dock that is open already has.
  if (getDockState().open) return;
  if (projectId) warmConversations(projectId);
  else warmConversations();
}

/**
 * Loads the dock's code and reads the conversation lists ahead of the first
 * Ask AI click, so the dock opens without waiting for either: the full history,
 * and on a project page that project's conversations, which its start page lists.
 */
export function prefetchAssistant(): void {
  void loadAssistantDock();
  warm(null);
  const projectId = getActiveSurface()?.project?.id;
  if (projectId) warm(projectId);
}

/**
 * Runs `task` once the browser is idle, at the latest after IDLE_TIMEOUT_MS
 * (after a plain timer where there are no idle callbacks). Returns the cancel.
 */
export function whenIdle(task: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(() => task(), { timeout: IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, IDLE_TIMEOUT_MS);
  return () => window.clearTimeout(handle);
}

/** Tests: load and prefetch again. */
export function resetDockLoader(): void {
  dock = null;
  loading = null;
  failed = false;
  failures = 0;
  warmed.clear();
}
