import type { DatasetConnection } from "@/lib/workflows/datasetConnection";

/**
 * The contract every Add Layer flow exposes, and the only thing a host needs.
 *
 * A flow owns its state, its validation and its submit; the host owns the frame and where
 * `action` sits. That split is what lets the same flow appear in a dialog today and in a
 * side panel or a page later.
 */
export type FlowAction = {
  label: string;
  disabled: boolean;
  /** Shown as a tooltip when disabled, for reasons the label cannot carry. */
  reason?: string;
  /** D7: who else the project belongs to or is shared with, when there is anyone. */
  notice?: string;
  run: () => void | Promise<void>;
};

export type FlowController = {
  action: FlowAction;
  isBusy: boolean;
  reset: () => void;
};

/** A workflow node's use of a flow: its saved connection, and where a new one goes. */
export type WorkflowUse = {
  initial?: DatasetConnection;
  onUse: (connection: DatasetConnection) => void;
};
