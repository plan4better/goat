import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import { deepEqual } from "@/lib/style/json";
import { type SaveResult, StyleSaver, type StyleTransport, bindPageLifecycle } from "@/lib/style/save";

const DOC = {
  version: 1,
  kind: "vector",
  symbol: { fill: { color: "#cccccc", opacity: 1 }, outline: { width: 1 } },
} as LayerStyle;

const withFill = (fill: object, outline: object = { width: 1 }) =>
  ({ ...DOC, symbol: { fill: { color: "#cccccc", opacity: 1, ...fill }, outline } }) as LayerStyle;

interface Sent {
  base_rev: number;
  document: LayerStyle;
  keepalive: boolean;
}

/** A transport whose answers the test hands out one by one; unanswered saves stay pending. */
function fakeTransport(current = { document: DOC, revision: 41 }) {
  const saves: Sent[] = [];
  const resolvers: Array<(r: SaveResult) => void> = [];
  const transport: StyleTransport = {
    save: (body, opts) => {
      saves.push({ ...body, keepalive: opts.keepalive });
      return new Promise((resolve) => resolvers.push(resolve));
    },
    load: async () => current,
  };
  const answer = async (result: SaveResult) => {
    resolvers.shift()?.(result);
    await vi.advanceTimersByTimeAsync(0);
  };
  const ok = (document: LayerStyle, revision: number) => answer({ ok: true, document, revision, issues: [] });
  return { transport, saves, answer, ok };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("StyleSaver", () => {
  it("saves once, one second after the last edit", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    s.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(900);
    s.edit(withFill({ color: "#222222" }));
    await vi.advanceTimersByTimeAsync(999);
    expect(t.saves).toHaveLength(0);
    expect(s.status).toBe("saving");
    await vi.advanceTimersByTimeAsync(1);
    expect(t.saves).toEqual([{ base_rev: 41, document: withFill({ color: "#222222" }), keepalive: false }]);
  });

  it("does not send a copy equal to the saved document", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    s.edit(withFill({ color: "#111111" }));
    s.edit(withFill({}));
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.saves).toHaveLength(0);
    expect(s.status).toBe("saved");
  });

  it("takes the server's document when nothing changed while saving", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    s.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(1000);
    const stored = { ...withFill({ color: "#111111" }), legend: false } as LayerStyle;
    await t.ok(stored, 42);
    expect(s.document).toEqual(stored);
    expect(s.revision).toBe(42);
    expect(s.status).toBe("saved");
    expect(s.pending).toBe(false);
  });

  it("keeps one save in flight and re-applies edits made meanwhile on the reply", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    s.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(1000);
    s.edit(withFill({ color: "#111111", opacity: 0.5 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.saves).toHaveLength(1);
    // the reply carries another author's change: outline width 3
    await t.ok(withFill({ color: "#111111" }, { width: 3 }), 43);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.saves).toHaveLength(2);
    expect(t.saves[1]).toEqual({
      base_rev: 43,
      document: withFill({ color: "#111111", opacity: 0.5 }, { width: 3 }),
      keepalive: false,
    });
    expect(s.document).toEqual(withFill({ color: "#111111", opacity: 0.5 }, { width: 3 }));
  });

  it("receive re-applies edits made meanwhile", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    s.edit(withFill({ opacity: 0.5 }));
    // the opening check answers a recomputed style (another outline) before the edit is sent
    s.receive({ document: withFill({}, { width: 3 }), revision: 42, issues: [] });
    expect(s.revision).toBe(42);
    expect(s.stored).toEqual(withFill({}, { width: 3 }));
    expect(s.document).toEqual(withFill({ opacity: 0.5 }, { width: 3 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.saves).toEqual([
      { base_rev: 42, document: withFill({ opacity: 0.5 }, { width: 3 }), keepalive: false },
    ]);
    // an older answer than what the saver holds changes nothing
    s.receive({ document: DOC, revision: 40, issues: [] });
    expect(s.revision).toBe(42);
  });

  it("retries after 1, 2, 4 and 8 seconds, then every 30, keeping the copy", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    s.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(1000);
    const sentAt: number[] = [];
    for (const wait of [1000, 2000, 4000, 8000, 30000, 30000]) {
      await t.answer({ ok: false, status: 0 });
      expect(s.status).toBe("retrying");
      await vi.advanceTimersByTimeAsync(wait - 1);
      sentAt.push(t.saves.length);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(sentAt).toEqual([1, 2, 3, 4, 5, 6]);
    expect(t.saves).toHaveLength(7);
    expect(t.saves.every((x) => deepEqual(x.document, withFill({ color: "#111111" })))).toBe(true);
  });

  it("treats 5xx and 429 as retryable and shows offline while the browser is offline", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    s.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(1000);
    await t.answer({ ok: false, status: 503 });
    expect(s.status).toBe("retrying");
    await vi.advanceTimersByTimeAsync(1000);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await t.answer({ ok: false, status: 429 });
    expect(s.status).toBe("offline");
  });

  it("retries at once when the browser is back online", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    const win = new EventTarget() as unknown as Window;
    const unbind = bindPageLifecycle(s, win);
    s.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(1000);
    await t.answer({ ok: false, status: 0 });
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.saves).toHaveLength(2);
    unbind();
  });

  it("renews the session on 401 and retries", async () => {
    const t = fakeTransport();
    const renewSession = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41, renewSession });
    s.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(1000);
    await t.answer({ ok: false, status: 401 });
    expect(renewSession).toHaveBeenCalledTimes(1);
    expect(t.saves).toHaveLength(2);
    await t.answer({ ok: false, status: 401 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(t.saves).toHaveLength(2);
  });

  it.each([
    [403, undefined, "forbidden"],
    [404, undefined, "deleted"],
    [409, "base_too_old", "base_too_old"],
  ] as const)("stops on %s and says why", async (status, code, reason) => {
    const t = fakeTransport();
    const onStop = vi.fn();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41, onStop });
    s.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(1000);
    await t.answer({ ok: false, status, code });
    expect(onStop).toHaveBeenCalledWith(reason);
    expect(s.status).toBe("stopped");
    s.edit(withFill({ color: "#222222" }));
    await vi.advanceTimersByTimeAsync(60000);
    expect(t.saves).toHaveLength(1);
  });

  it("applies the changes to the current style after base_too_old, or discards them", async () => {
    const current = { document: withFill({}, { width: 5 }), revision: 90 };
    const t = fakeTransport(current);
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    s.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(1000);
    await t.answer({ ok: false, status: 409, code: "base_too_old" });
    await s.resolveBaseTooOld("apply");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.saves[1]).toEqual({
      base_rev: 90,
      document: withFill({ color: "#111111" }, { width: 5 }),
      keepalive: false,
    });

    const t2 = fakeTransport(current);
    const s2 = new StyleSaver({ transport: t2.transport, document: DOC, revision: 41 });
    s2.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(1000);
    await t2.answer({ ok: false, status: 409, code: "base_too_old" });
    await s2.resolveBaseTooOld("discard");
    expect(s2.document).toEqual(current.document);
    expect(s2.revision).toBe(90);
    expect(s2.status).toBe("saved");
  });

  it("flushes a pending change at once with keepalive", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    s.edit(withFill({ color: "#111111" }));
    s.flush();
    expect(t.saves).toEqual([{ base_rev: 41, document: withFill({ color: "#111111" }), keepalive: true }]);
  });

  it("warns before unload while a change is pending and flushes on pagehide", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    const win = new EventTarget() as unknown as Window;
    const unbind = bindPageLifecycle(s, win);
    const quiet = new Event("beforeunload", { cancelable: true });
    win.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);
    s.edit(withFill({ color: "#111111" }));
    const warned = new Event("beforeunload", { cancelable: true });
    win.dispatchEvent(warned);
    expect(warned.defaultPrevented).toBe(true);
    win.dispatchEvent(new Event("pagehide"));
    expect(t.saves).toEqual([{ base_rev: 41, document: withFill({ color: "#111111" }), keepalive: true }]);
    unbind();
  });

  it("treats a transport that throws like no answer and retries", async () => {
    let calls = 0;
    const transport: StyleTransport = {
      save: async (body) => {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return { ok: true, document: body.document, revision: 42, issues: [] };
      },
      load: async () => ({ document: DOC, revision: 41 }),
    };
    const s = new StyleSaver({ transport, document: DOC, revision: 41 });
    s.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.status).toBe("retrying");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    expect(s.status).toBe("saved");
  });

  it("after an answer no retry fixes, the next edit saves again", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    s.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(1000);
    await t.answer({ ok: false, status: 400 });
    expect(s.status).toBe("retrying");
    s.edit(withFill({ color: "#222222" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.saves).toHaveLength(2);
    expect(t.saves[1].document).toEqual(withFill({ color: "#222222" }));
  });

  it("a renewed session refused again backs off instead of resending at once", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({
      transport: t.transport,
      document: DOC,
      revision: 41,
      renewSession: async () => true,
    });
    s.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(1000);
    await t.answer({ ok: false, status: 401 });
    expect(t.saves).toHaveLength(2);
    await t.answer({ ok: false, status: 401 });
    expect(t.saves).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.saves).toHaveLength(3);
  });

  it("saveNow sends at once without keepalive", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    s.edit(withFill({ color: "#111111" }));
    s.saveNow();
    expect(t.saves).toEqual([{ base_rev: 41, document: withFill({ color: "#111111" }), keepalive: false }]);
  });

  it("saveNow while a save is in flight sends next", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    s.edit(withFill({ color: "#111111" }));
    s.saveNow();
    s.edit(withFill({ color: "#222222" }));
    s.saveNow();
    expect(t.saves).toHaveLength(1);
    await t.ok(withFill({ color: "#111111" }), 42);
    expect(t.saves).toHaveLength(2);
    expect(t.saves[1]).toEqual({ base_rev: 42, document: withFill({ color: "#222222" }), keepalive: false });
  });

  it("stored is the server's last document", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    expect(s.stored).toEqual(DOC);
    s.edit(withFill({ color: "#111111" }));
    s.saveNow();
    const reply = { ...withFill({ color: "#111111" }), legend: false } as LayerStyle;
    await t.ok(reply, 42);
    expect(s.stored).toEqual(reply);
  });

  it("tells subscribers about every change of state", async () => {
    const t = fakeTransport();
    const s = new StyleSaver({ transport: t.transport, document: DOC, revision: 41 });
    const listener = vi.fn();
    const unsubscribe = s.subscribe(listener);
    s.edit(withFill({ color: "#111111" }));
    await vi.advanceTimersByTimeAsync(1000);
    await t.ok(withFill({ color: "#111111" }), 42);
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
    unsubscribe();
    s.edit(withFill({ color: "#222222" }));
    const calls = listener.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(listener.mock.calls.length).toBe(calls);
  });
});
