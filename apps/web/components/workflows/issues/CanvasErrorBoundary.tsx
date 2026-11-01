"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

import DamagedWorkflowNotice from "@/components/workflows/issues/DamagedWorkflowNotice";

interface CanvasErrorBoundaryProps {
  /** The open workflow: another one opening draws the canvas again. */
  resetKey: string | null;
  children: ReactNode;
}

interface CanvasErrorBoundaryState {
  failed: boolean;
}

/**
 * Keeps a step that fails to draw (data it does not expect) to the canvas:
 * the damaged notice takes the canvas's place instead of the error unmounting
 * the whole project page.
 */
export default class CanvasErrorBoundary extends Component<
  CanvasErrorBoundaryProps,
  CanvasErrorBoundaryState
> {
  state: CanvasErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): CanvasErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("The workflow canvas failed to render", error, info.componentStack);
  }

  componentDidUpdate(previous: CanvasErrorBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <DamagedWorkflowNotice issues={[]} cause="drawing" />;
  }
}
