"use client";

import { useMediaQuery } from "@mui/material";
import { type RefObject, useEffect, useRef } from "react";

import { useWorkflowIssuesContext } from "@/components/workflows/issues/WorkflowIssuesContext";

/** `data-field` of the list of a step's own issues at the top of its settings. */
export const STEP_ISSUES_FIELD = "__step__";

const FOCUSABLE = [
  "input:not([disabled]):not([type='hidden'])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "button:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * Requests already carried out. The settings panel mounts afresh for every
 * step, so the request it was opened for is remembered here rather than in
 * the panel; otherwise a later visit to the same step would jump to that
 * setting again. Every request is a new object, so this needs no clearing.
 */
const done = new WeakSet<object>();

const fieldElement = (root: HTMLElement, field: string): HTMLElement | null => {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-field]"))) {
    if (element.dataset.field === field) return element;
  }
  return null;
};

/**
 * Carries out "go to this setting" (an issue row or a step badge) in one
 * step's settings panel: scrolls the element marked `data-field={field}` into
 * view and focuses its first focusable element. While the field is not
 * mounted, `reveal(field)` is asked to open whatever hides it (a collapsed
 * section, closed advanced options) and the step's own issue list is scrolled
 * into view once; the panel tries again after every render, which also covers
 * a tool description that is still loading. A request without a field scrolls
 * to the step's issue list.
 *
 * `reveal` runs on every render until the field shows, so it must leave state
 * unchanged when there is nothing left to open.
 */
export function useStepFieldFocus(
  nodeId: string,
  reveal?: (field: string) => void
): RefObject<HTMLDivElement | null> {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { focusRequest } = useWorkflowIssuesContext();
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const summaryShownFor = useRef<object | null>(null);

  useEffect(() => {
    const request = focusRequest;
    const root = rootRef.current;
    if (!request || request.nodeId !== nodeId || done.has(request) || !root) return;
    const behavior: ScrollBehavior = reduceMotion ? "auto" : "smooth";

    const target = request.field ? fieldElement(root, request.field) : null;
    if (target) {
      target.scrollIntoView?.({ block: "center", behavior });
      target.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
      done.add(request);
      return;
    }

    if (request.field) reveal?.(request.field);
    else done.add(request);
    if (summaryShownFor.current !== request) {
      summaryShownFor.current = request;
      fieldElement(root, STEP_ISSUES_FIELD)?.scrollIntoView?.({ block: "nearest", behavior });
    }
  });

  return rootRef;
}
