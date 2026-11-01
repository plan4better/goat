import { useSyncExternalStore } from "react";

import type { Choice } from "@/lib/assistant/ask";
import type { AssistantSurfaceAdapter, PageContext, SourceRef, UndoFn } from "@/lib/assistant/types";

/**
 * State of the assistant dock, outside React so the root, the Header and the
 * pages read the same value without a provider tree. Adapters hold functions,
 * which is why this is not a Redux slice.
 */

const STORAGE_KEY = "goat:assistant-dock";

export interface PendingRun {
  conversationId: string;
  title: string;
  since: number;
  /**
   * The newest assistant message when the run was sent: only a newer one is
   * this run's answer (a refused send leaves the previous answer last).
   */
  knownAnswerId?: string | null;
}

/** A pending run read back from sessionStorage, or null when it is not one. */
function pendingRunOf(value: unknown): PendingRun | null {
  if (typeof value !== "object" || value === null) return null;
  const run = value as Record<string, unknown>;
  const known = run.knownAnswerId ?? null;
  if (
    typeof run.conversationId !== "string" ||
    typeof run.title !== "string" ||
    typeof run.since !== "number" ||
    (known !== null && typeof known !== "string")
  ) {
    return null;
  }
  return { conversationId: run.conversationId, title: run.title, since: run.since, knownAnswerId: known };
}

export interface DockState {
  /** AI is available here: status, route and kill switch (set by AssistantRoot). */
  enabled: boolean;
  open: boolean;
  expanded: boolean;
  /** null: a new conversation, created on the first send. */
  conversationId: string | null;
  /** A proposal to scroll to after "Open in project to review". */
  review: { conversationId: string; partId: string } | null;
  /**
   * The newest binding the dock made itself (PATCH from "Open in project to
   * review"). The open conversation applies it at once, like a binding its own
   * send caused; a binding never changes afterwards, so it is not cleared.
   */
  bound: { conversationId: string; projectId: string; projectName: string | null } | null;
  /**
   * A project page that will register no surface (its project failed to load,
   * or its mode has none): the dock stops waiting for it at once.
   */
  noSurfaceProject: string | null;
  /** Runs this tab started whose end it should announce (RunWatcher). */
  pending: PendingRun[];
  /** Proposal cards the user applied or discarded, by part id. */
  proposals: Record<string, "applied" | "discarded">;
  /**
   * The assistant refused an answer because the organization's AI credits are
   * used up (402): the composer gives way to that line at once, before the
   * balance is read again. Cleared when a later balance shows credits left.
   */
  aiCreditsUsedUp: AiCreditsRefusal | null;
  /**
   * The user this state belongs to. The tab keeps it across a sign-out, so the
   * next user would otherwise open the previous user's conversation.
   */
  owner: string | null;
}

/** What a 402 `ai_credits_used_up` says: when the pool is refilled, or the trial ends. */
export interface AiCreditsRefusal {
  resetsOn: string | null;
  onTrial: boolean;
}

const CLOSED: DockState = {
  enabled: false,
  open: false,
  expanded: false,
  conversationId: null,
  review: null,
  bound: null,
  noSurfaceProject: null,
  pending: [],
  proposals: {},
  aiCreditsUsedUp: null,
  owner: null,
};

function restore(): DockState {
  try {
    const raw = typeof window === "undefined" ? null : window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return CLOSED;
    const saved = JSON.parse(raw) as {
      open?: unknown;
      expanded?: unknown;
      conversationId?: unknown;
      pending?: unknown;
      owner?: unknown;
    };
    return {
      ...CLOSED,
      open: saved.open === true,
      expanded: saved.expanded === true,
      conversationId: typeof saved.conversationId === "string" ? saved.conversationId : null,
      // A reload keeps the runs this tab waits for, so RunWatcher still announces their end.
      pending: Array.isArray(saved.pending)
        ? saved.pending.map(pendingRunOf).filter((run): run is PendingRun => run !== null)
        : [],
      owner: typeof saved.owner === "string" ? saved.owner : null,
    };
  } catch {
    return CLOSED;
  }
}

let state: DockState = restore();
const dockListeners = new Set<() => void>();

function persist(): void {
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        open: state.open,
        expanded: state.expanded,
        conversationId: state.conversationId,
        pending: state.pending,
        owner: state.owner,
      })
    );
  } catch {
    // storage unavailable: the dock still works, it just starts closed next time
  }
}

export const getDockState = (): DockState => state;

/**
 * Ties the dock to the signed-in user. Another user's open conversation,
 * pending runs and proposal states are dropped (the dock's size and whether it
 * is open stay: they are this tab's layout, not the user's data).
 */
export function claimDock(userId: string): void {
  if (state.owner === userId) return;
  const foreign = state.owner !== null;
  setDockState({
    owner: userId,
    ...(foreign
      ? { conversationId: null, pending: [], proposals: {}, review: null, bound: null, aiCreditsUsedUp: null }
      : {}),
  });
}

export function setDockState(patch: Partial<DockState> | ((current: DockState) => Partial<DockState>)): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  persist();
  dockListeners.forEach((listener) => listener());
}

const subscribeDock = (listener: () => void) => {
  dockListeners.add(listener);
  return () => {
    dockListeners.delete(listener);
  };
};

export const useDockState = (): DockState => useSyncExternalStore(subscribeDock, getDockState, () => CLOSED);

export const openConversation = (conversationId: string | null) =>
  setDockState({ open: true, conversationId });

export const addPendingRun = (run: PendingRun) =>
  setDockState((current) => ({
    pending: [...current.pending.filter((p) => p.conversationId !== run.conversationId), run],
  }));

export function removePendingRun(conversationId: string): void {
  // Nothing to forget: no new state, so nothing re-renders.
  if (!state.pending.some((p) => p.conversationId === conversationId)) return;
  setDockState((current) => ({
    pending: current.pending.filter((p) => p.conversationId !== conversationId),
  }));
}

export const markProposal = (partId: string, value: "applied" | "discarded" | null) =>
  setDockState((current) => {
    const proposals = { ...current.proposals };
    if (value) proposals[partId] = value;
    else delete proposals[partId];
    return { proposals };
  });

/**
 * Identity of one mounted page (one `useAssistantSurface` mount). It survives
 * re-registrations of that page's adapter and ends when the page unmounts.
 */
export type SurfaceOwner = symbol;
export const createSurfaceOwner = (): SurfaceOwner => Symbol("assistant-surface-owner");

/**
 * Undo functions of applied proposals, with the mount that applied them: an
 * undo writes into that page's state, so it goes when the page unmounts, not
 * when its adapter registers again (a changed context re-registers).
 */
const undoers = new Map<string, { undo: UndoFn; owner: SurfaceOwner }>();
/** Owners whose page is mounted. An undo for any other owner is ignored. */
const liveOwners = new Set<SurfaceOwner>();
export const markOwnerLive = (owner: SurfaceOwner): void => {
  liveOwners.add(owner);
};
/** The page of `owner` unmounted: no more undoers for it, now or from a pending apply. */
export function releaseOwner(owner: SurfaceOwner): void {
  liveOwners.delete(owner);
  dropProposalUndoers(owner);
}
/**
 * One undo per owner: a newer apply on the same page drops the older undoers,
 * which would restore the page from before the newer apply.
 */
export function setProposalUndo(partId: string, undo: UndoFn | undefined, owner: SurfaceOwner): void {
  if (undo && !liveOwners.has(owner)) return;
  if (undo) {
    dropProposalUndoers(owner);
    undoers.set(partId, { undo, owner });
  } else undoers.delete(partId);
}
export function takeProposalUndo(partId: string): UndoFn | undefined {
  const entry = undoers.get(partId);
  undoers.delete(partId);
  return entry?.undo;
}
export const hasProposalUndo = (partId: string): boolean => undoers.has(partId);
/** Drops the undoers of `owner`; `releaseOwner` is the unmount path. */
export function dropProposalUndoers(owner: SurfaceOwner): void {
  for (const [partId, entry] of undoers) {
    if (entry.owner === owner) undoers.delete(partId);
  }
}

/**
 * A message the user sent while an answer was running: it goes out when that
 * answer ends. One per conversation; a further send adds its text to it.
 */
export interface QueuedMessage {
  text: string;
  /** The i18n key of why the server refused it, once it was sent and refused. */
  reason: string | null;
}

/**
 * What the user has typed but not sent, per conversation id ("new" for a
 * conversation not created yet). Expanding or collapsing the dock mounts the
 * composer again, so it restores from here; an accepted send clears it.
 * Kept in memory only, outside the dock state, so typing re-renders nothing else.
 */
export interface ComposerDraft {
  text: string;
  sources: SourceRef[];
  /** Keys of the context chips the user removed, valid for `surfaceKey` only. */
  removed: string[];
  surfaceKey: string;
  /** The message waiting for the running answer to end, kept like the text. */
  queued: QueuedMessage | null;
}
export const NEW_CONVERSATION_DRAFT = "new";
const drafts = new Map<string, ComposerDraft>();
export const getDraft = (key: string): ComposerDraft | null => drafts.get(key) ?? null;
export function saveDraft(key: string, patch: Partial<ComposerDraft>): void {
  const next: ComposerDraft = {
    text: "",
    sources: [],
    removed: [],
    surfaceKey: "",
    queued: null,
    ...drafts.get(key),
    ...patch,
  };
  if (!next.text && !next.sources.length && !next.removed.length && !next.queued) drafts.delete(key);
  else drafts.set(key, next);
}
/** Forgets all that is kept for `key`, its queued message included. */
export const clearDraft = (key: string): void => {
  drafts.delete(key);
};

/**
 * The choices made in an ask card not sent yet, one per question, by card id
 * (minted per card by the server, so unique across conversations). Expanding
 * or collapsing the dock mounts the card's panel again, so it restores from
 * here, as the composer does from its draft. The chat drops them once the
 * server took the message that answers or passes over the card: a refused one
 * opens the card again with its picks. Kept in memory only, like the drafts.
 */
const askChoices = new Map<string, Choice[]>();
/** The tab the card's panel shows, next to its choices. */
const askTabs = new Map<string, number>();
/**
 * Why the composer holds an open card instead of the panel: "reply", the
 * person chose "Reply in text instead"; "typing", the card came while they
 * typed in the composer. By card id: a chat mounted again keeps the composer.
 */
export type AskInComposer = "reply" | "typing";
const askInComposer = new Map<string, AskInComposer>();
export const getAskChoices = (cardId: string): Choice[] | null => askChoices.get(cardId) ?? null;
export function saveAskChoices(cardId: string, choices: Choice[]): void {
  askChoices.set(cardId, choices);
}
export const getAskTab = (cardId: string): number => askTabs.get(cardId) ?? 0;
export function saveAskTab(cardId: string, tab: number): void {
  askTabs.set(cardId, tab);
}
export const getAskInComposer = (cardId: string): AskInComposer | null => askInComposer.get(cardId) ?? null;
export function setAskInComposer(cardId: string, why: AskInComposer | null): void {
  if (why) askInComposer.set(cardId, why);
  else askInComposer.delete(cardId);
}
/** Forgets what is kept for the card: its choices, its tab, and why the composer holds it. */
export const clearAskChoices = (cardId: string): void => {
  askChoices.delete(cardId);
  askTabs.delete(cardId);
  askInComposer.delete(cardId);
};

/** The message that creates a conversation, sent by its chat view once mounted. */
type FirstMessage = { conversationId: string; text: string; context: PageContext | null };
let firstMessage: FirstMessage | null = null;
export const setFirstMessage = (message: FirstMessage) => {
  firstMessage = message;
};
export const peekFirstMessage = (conversationId: string): FirstMessage | null =>
  firstMessage?.conversationId === conversationId ? firstMessage : null;
export const clearFirstMessage = (conversationId: string) => {
  if (firstMessage?.conversationId === conversationId) firstMessage = null;
};

// -- the one registered surface adapter (spec §6.3) ------------------------

let surface: AssistantSurfaceAdapter | null = null;
let surfaceOwner: SurfaceOwner | null = null;
const surfaceListeners = new Set<() => void>();
const notifySurface = () => surfaceListeners.forEach((listener) => listener());

/**
 * The newest registration wins; unregistering an older one changes nothing.
 * `owner` is the mounting page's token, read back with `getActiveSurfaceOwner`.
 * Unregistering keeps the page's undoers (see `dropProposalUndoers`).
 */
export function registerSurface(
  adapter: AssistantSurfaceAdapter,
  owner: SurfaceOwner = createSurfaceOwner()
): () => void {
  surface = adapter;
  surfaceOwner = owner;
  notifySurface();
  return () => {
    if (surface === adapter) {
      surface = null;
      surfaceOwner = null;
      notifySurface();
    }
  };
}

export const getActiveSurface = (): AssistantSurfaceAdapter | null => surface;
/** The owner token of the page that registered the active surface. */
export const getActiveSurfaceOwner = (): SurfaceOwner | null => surfaceOwner;

const subscribeSurface = (listener: () => void) => {
  surfaceListeners.add(listener);
  return () => {
    surfaceListeners.delete(listener);
  };
};

export const useActiveSurface = (): AssistantSurfaceAdapter | null =>
  useSyncExternalStore(subscribeSurface, getActiveSurface, () => null);

/** Tests: start from what sessionStorage holds, with nothing registered. */
export function resetAssistantStore(): void {
  state = restore();
  surface = null;
  surfaceOwner = null;
  undoers.clear();
  drafts.clear();
  askChoices.clear();
  askTabs.clear();
  askInComposer.clear();
  firstMessage = null;
  dockListeners.forEach((listener) => listener());
  notifySurface();
}
