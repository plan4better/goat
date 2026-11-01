import { describe, expect, it } from "vitest";

import { ChangedElsewhereError } from "@/lib/api/changedElsewhere";
import { RevisionedSaver, type SaveConflict } from "@/lib/utils/revisionedSaver";

type Update = { config?: string; name?: string };

const ada = { id: "user-2", firstname: "Ada", lastname: "Lovelace", avatar: null };

/** A saver over a revision map, whose sends wait until the test answers them. */
const setup = ({ open = () => true }: { open?: (id: string) => boolean } = {}) => {
  const revisions = new Map<string, number>();
  const conflicts: (SaveConflict | null)[] = [];
  const sends: {
    id: string;
    update: Update;
    base: number | undefined;
    answer: (revision: number) => void;
    refuse: (error: Error) => void;
  }[] = [];
  const saver = new RevisionedSaver<Update>({
    send: (id, update, base) =>
      new Promise((resolve, reject) => {
        sends.push({ id, update, base, answer: resolve, refuse: reject });
      }),
    getRevision: (id) => revisions.get(id),
    setRevision: (id, revision) => revisions.set(id, revision),
    isOpen: open,
    onConflict: (conflict) => conflicts.push(conflict),
  });
  return { saver, revisions, conflicts, sends };
};

/** Lets the promise chain take its next steps. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const conflictAt = (revision: number) =>
  new ChangedElsewhereError(revision, "2026-10-25T09:12:03+00:00", ada);

describe("RevisionedSaver", () => {
  it("sends a save on the revision the copy was loaded at and keeps the one core returns", async () => {
    const { saver, revisions, sends } = setup();
    saver.seed("doc", 3);

    const saved = saver.save("doc", { config: "a" });
    await settle();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ id: "doc", update: { config: "a" }, base: 3 });

    sends[0].answer(4);
    expect(await saved).toBe("saved");
    expect(revisions.get("doc")).toBe(4);
  });

  it("sends one save at a time, each on the revision the last one returned", async () => {
    const { saver, sends } = setup();
    saver.seed("doc", 3);

    void saver.save("doc", { config: "a" });
    await settle();
    void saver.save("doc", { config: "b" });
    await settle();
    expect(sends).toHaveLength(1);

    sends[0].answer(4);
    await settle();
    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ update: { config: "b" }, base: 4 });
  });

  it("sends the saves that queued up behind one under way as one, the latest config winning", async () => {
    const { saver, sends } = setup();
    saver.seed("doc", 3);

    void saver.save("doc", { config: "a" });
    await settle();
    const second = saver.save("doc", { config: "b" });
    const third = saver.save("doc", { name: "Renamed" });
    const fourth = saver.save("doc", { config: "c" });

    sends[0].answer(4);
    await settle();
    expect(sends).toHaveLength(2);
    expect(sends[1].update).toEqual({ config: "c", name: "Renamed" });

    sends[1].answer(5);
    expect(await Promise.all([second, third, fourth])).toEqual(["saved", "saved", "saved"]);
  });

  it("holds a save core refuses, and every later one, until Keep mine sends them on the stored revision", async () => {
    const { saver, conflicts, sends } = setup();
    saver.seed("doc", 3);

    const refused = saver.save("doc", { config: "a" });
    await settle();
    sends[0].refuse(conflictAt(5));
    expect(await refused).toBe("held");
    expect(conflicts).toEqual([
      { id: "doc", revision: 5, updatedAt: "2026-10-25T09:12:03+00:00", updatedBy: ada },
    ]);
    expect(saver.conflict?.revision).toBe(5);

    expect(await saver.save("doc", { name: "Renamed" })).toBe("held");
    await settle();
    expect(sends).toHaveLength(1);

    const kept = saver.keepMine({ config: "b" });
    expect(conflicts.at(-1)).toBeNull();
    await settle();
    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ update: { config: "b", name: "Renamed" }, base: 5 });
    sends[1].answer(6);
    expect(await kept).toBe("saved");
  });

  it("holds a save that was waiting behind the refused one", async () => {
    const { saver, sends } = setup();
    saver.seed("doc", 3);

    void saver.save("doc", { config: "a" });
    await settle();
    const waiting = saver.save("doc", { config: "b" });
    sends[0].refuse(conflictAt(5));

    expect(await waiting).toBe("held");
    expect(sends).toHaveLength(1);

    void saver.keepMine();
    await settle();
    expect(sends[1]).toMatchObject({ update: { config: "b" }, base: 5 });
  });

  it("lets Reload drop what was held: later saves go out again", async () => {
    const { saver, conflicts, sends } = setup();
    saver.seed("doc", 3);

    void saver.save("doc", { config: "a" });
    await settle();
    sends[0].refuse(conflictAt(5));
    await settle();

    saver.dismiss();
    saver.setRevision("doc", 5);
    expect(saver.conflict).toBeNull();
    expect(conflicts.at(-1)).toBeNull();

    void saver.save("doc", { config: "after reload" });
    await settle();
    expect(sends[1]).toMatchObject({ update: { config: "after reload" }, base: 5 });
  });

  it("keeps saving the other documents while one is held", async () => {
    const { saver, sends } = setup();
    saver.seed("doc", 3);
    saver.seed("other", 1);

    void saver.save("doc", { config: "a" });
    await settle();
    sends[0].refuse(conflictAt(5));
    await settle();

    const other = saver.save("other", { name: "Renamed" });
    await settle();
    expect(sends[1]).toMatchObject({ id: "other", base: 1 });
    sends[1].answer(2);
    expect(await other).toBe("saved");
  });

  it("fails a refused save of a document the editor does not show, holding nothing", async () => {
    const { saver, conflicts, sends } = setup({ open: (id) => id === "doc" });

    const refused = saver.save("other", { name: "Renamed" });
    await settle();
    sends[0].refuse(conflictAt(2));

    await expect(refused).rejects.toBeInstanceOf(ChangedElsewhereError);
    expect(saver.conflict).toBeNull();
    expect(conflicts).toEqual([]);
  });

  it("fails any other refusal without stopping the saves after it", async () => {
    const { saver, sends } = setup();
    saver.seed("doc", 3);

    const failed = saver.save("doc", { config: "a" });
    await settle();
    sends[0].refuse(new Error("offline"));
    await expect(failed).rejects.toThrow("offline");

    const next = saver.save("doc", { config: "b" });
    await settle();
    expect(sends[1]).toMatchObject({ update: { config: "b" }, base: 3 });
    sends[1].answer(4);
    expect(await next).toBe("saved");
  });

  it("keeps a known revision over an older one a list read brings", () => {
    const { saver, revisions } = setup();
    saver.seed("doc", 4);
    saver.seed("doc", 3);
    expect(revisions.get("doc")).toBe(4);
    saver.seed("doc", 6);
    expect(revisions.get("doc")).toBe(6);
    saver.seed("doc", undefined);
    expect(revisions.get("doc")).toBe(6);
  });

  it("tells the revision a document's copy is based on", async () => {
    const { saver, sends } = setup();
    expect(saver.revisionOf("doc")).toBeUndefined();
    saver.seed("doc", 3);
    expect(saver.revisionOf("doc")).toBe(3);

    const saved = saver.save("doc", { config: "a" });
    await settle();
    sends[0].answer(4);
    await saved;
    expect(saver.revisionOf("doc")).toBe(4);
  });

  it("tells when the saves under way are done, also a failed one", async () => {
    const { saver, sends } = setup();
    saver.seed("doc", 3);
    void saver.save("doc", { config: "a" }).catch(() => undefined);
    let idle = false;
    void saver.idle().then(() => {
      idle = true;
    });
    await settle();
    expect(idle).toBe(false);
    sends[0].refuse(new Error("offline"));
    await settle();
    expect(idle).toBe(true);
    await expect(saver.idle()).resolves.toBeUndefined();
  });

  it("lets no read raise the base while a save is under way or waiting", async () => {
    // A save waiting behind one under way was made on the copy the page
    // showed: a read of another tab's version must not become its base.
    const { saver, sends } = setup();
    saver.seed("doc", 3);
    void saver.save("doc", { config: "a" });
    await settle();
    void saver.save("doc", { config: "b" });
    saver.seed("doc", 6);
    expect(saver.revisionOf("doc")).toBe(3);
    sends[0].answer(4);
    await settle();
    saver.seed("doc", 6);
    expect(sends[1]).toMatchObject({ update: { config: "b" }, base: 4 });
    sends[1].answer(5);
    await settle();
    // With nothing under way, a newer read counts again.
    saver.seed("doc", 6);
    expect(saver.revisionOf("doc")).toBe(6);
  });

  it("does nothing on Keep mine without a conflict", async () => {
    const { saver, sends } = setup();
    expect(await saver.keepMine()).toBeNull();
    await settle();
    expect(sends).toHaveLength(0);
  });
});
