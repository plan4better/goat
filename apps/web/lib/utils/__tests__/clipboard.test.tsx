import { Dialog, DialogContent } from "@mui/material";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "@/lib/utils/clipboard";

const setClipboard = (clipboard: unknown) =>
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });

const setExecCommand = (execCommand: unknown) =>
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });

/** An `execCommand` that records what "copy" would copy: the page's selection at that moment. */
const recordingCopy = (result = true) => {
  const copied: string[] = [];
  setExecCommand(
    vi.fn((command: string) => {
      if (command === "copy") copied.push(document.getSelection()?.toString() ?? "");
      return result;
    })
  );
  return copied;
};

/** Every element that took the focus while `run` ran. */
const focusMoves = async (run: () => Promise<unknown>) => {
  const moves: EventTarget[] = [];
  const record = (event: FocusEvent) => moves.push(event.target as EventTarget);
  document.addEventListener("focusin", record);
  try {
    await run();
  } finally {
    document.removeEventListener("focusin", record);
  }
  return moves;
};

afterEach(() => {
  // The dialog first: React removes its own nodes.
  cleanup();
  setClipboard(undefined);
  setExecCommand(undefined);
  vi.restoreAllMocks();
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("copyText", () => {
  it("writes through the Clipboard API where the browser offers it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = vi.fn(() => true);
    setClipboard({ writeText });
    setExecCommand(execCommand);

    expect(await copyText("https://example.org/a.tif")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://example.org/a.tif");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("without the Clipboard API (plain http), copies the value as the page's selection, leaving no trace", async () => {
    document.body.innerHTML = '<button id="copy">Copy</button>';
    (document.getElementById("copy") as HTMLButtonElement).focus();
    const before = document.body.innerHTML;
    const copied = recordingCopy();

    expect(await copyText("https://example.org/My%20File.tif")).toBe(true);
    expect(copied).toEqual(["https://example.org/My%20File.tif"]);
    expect(document.body.innerHTML).toBe(before);
  });

  it("keeps the lines of a value with several", async () => {
    const copied = recordingCopy();

    expect(await copyText("# Answer\n\nFirst line\nSecond line")).toBe(true);
    expect(copied).toEqual(["# Answer\n\nFirst line\nSecond line"]);
  });

  it("falls back the same way when the Clipboard API refuses", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) });
    const copied = recordingCopy();

    expect(await copyText("x")).toBe(true);
    expect(copied).toEqual(["x"]);
  });

  it("says it could not only when both ways fail", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) });
    recordingCopy(false);
    expect(await copyText("x")).toBe(false);

    setClipboard(undefined);
    setExecCommand(
      vi.fn(() => {
        throw new Error("SecurityError");
      })
    );
    expect(await copyText("x")).toBe(false);

    // A browser without either.
    setExecCommand(undefined);
    expect(await copyText("x")).toBe(false);
  });

  it("does not trust the copy when the value could not be selected", async () => {
    const execCommand = vi.fn(() => true);
    setExecCommand(execCommand);
    // A browser that keeps the selection where it was: nothing of the value is selected.
    vi.spyOn(Selection.prototype, "addRange").mockImplementation(() => undefined);

    expect(await copyText("https://example.org/a.tif")).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("does not trust a selection elsewhere on the page that holds the same text", async () => {
    document.body.innerHTML = '<p id="same">https://example.org/a.tif</p>';
    const elsewhere = document.createRange();
    elsewhere.selectNodeContents(document.getElementById("same") as HTMLElement);
    document.getSelection()?.addRange(elsewhere);
    const execCommand = vi.fn(() => true);
    setExecCommand(execCommand);
    // A browser that keeps the selection where it was: the paragraph, whose text equals the value.
    vi.spyOn(Selection.prototype, "removeAllRanges").mockImplementation(() => undefined);
    vi.spyOn(Selection.prototype, "addRange").mockImplementation(() => undefined);

    expect(await copyText("https://example.org/a.tif")).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("says it could not copy a value of line breaks only, which the page's selection cannot hold", async () => {
    const execCommand = vi.fn(() => true);
    setExecCommand(execCommand);

    expect(await copyText("\n")).toBe(false);
    expect(await copyText("\n\n")).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it.each(["a\n", "a\n\n", "# Answer\n\n- one\n"])(
    "copies a value that ends in a line break, which Chrome leaves out of the selected text (%j)",
    async (value) => {
      // Chrome's Selection.toString() drops the last line break of the selected span.
      const own = Selection.prototype.toString;
      vi.spyOn(Selection.prototype, "toString").mockImplementation(function (this: Selection) {
        return own.call(this).replace(/\n$/, "");
      });
      const execCommand = vi.fn(() => true);
      setExecCommand(execCommand);

      expect(await copyText(value)).toBe(true);
      expect(execCommand).toHaveBeenCalledWith("copy");
    }
  );

  it("copies nothing and says so for an empty value", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = vi.fn(() => true);
    setClipboard({ writeText });
    setExecCommand(execCommand);

    expect(await copyText("")).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it.each([
    [
      "execCommand throws",
      () =>
        setExecCommand(
          vi.fn(() => {
            throw new Error("SecurityError");
          })
        ),
    ],
    ["execCommand answers false", () => setExecCommand(vi.fn(() => false))],
    [
      "the value could not be selected",
      () => {
        setExecCommand(vi.fn(() => true));
        vi.spyOn(Selection.prototype, "addRange").mockImplementation(() => undefined);
      },
    ],
  ])("leaves no trace when %s", async (_case, arrange) => {
    document.body.innerHTML = '<p>Text</p><button id="copy">Copy</button>';
    (document.getElementById("copy") as HTMLButtonElement).focus();
    const before = document.body.innerHTML;
    arrange();

    expect(await copyText("https://example.org/a.tif")).toBe(false);
    expect(document.body.innerHTML).toBe(before);
  });

  it("answers false rather than failing when the text cannot be put on the page", async () => {
    setExecCommand(vi.fn(() => true));
    vi.spyOn(document.body, "appendChild").mockImplementation(() => {
      throw new DOMException("Refused", "HierarchyRequestError");
    });

    await expect(copyText("x")).resolves.toBe(false);
  });

  it.each(["input", "textarea"])("gives a focused %s its own selection back", async (tag) => {
    document.body.innerHTML = `<form><${tag} id="field"></${tag}></form>`;
    const field = document.getElementById("field") as HTMLInputElement;
    field.value = "abcdefghij";
    field.focus();
    field.setSelectionRange(2, 7, "backward");
    setExecCommand(
      vi.fn(() => {
        // As a browser does when the page's selection moves off the field.
        field.setSelectionRange(0, 0);
        return true;
      })
    );

    expect(await copyText("x")).toBe(true);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toEqual([2, 7, "backward"]);
  });

  it.each(["canvas", "video", "audio", "object", "embed", "input", "select"])(
    "puts the text beside a focused %s, which cannot show it, inside the same parent",
    async (tag) => {
      document.body.innerHTML = `<div role="dialog" id="trap"><${tag} id="focused" tabindex="0"></${tag}></div>`;
      const focused = document.getElementById("focused") as HTMLElement;
      focused.focus();
      let parent: Node | null | undefined;
      setExecCommand(
        vi.fn(() => {
          // The selected span (the range starts in it, or in its text), and where it was put.
          const anchor = document.getSelection()?.anchorNode;
          parent = (anchor?.nodeType === Node.TEXT_NODE ? anchor.parentNode : anchor)?.parentNode;
          return true;
        })
      );

      expect(await copyText("x")).toBe(true);
      expect(parent).toBe(document.getElementById("trap"));
    }
  );

  it("leaves the focus and the page's selection as they were", async () => {
    document.body.innerHTML = '<p id="text">Some text on the page</p><button id="copy">Copy</button>';
    const button = document.getElementById("copy") as HTMLButtonElement;
    button.focus();
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("text") as HTMLElement);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    expect(document.getSelection()?.toString()).toBe("Some text on the page");
    recordingCopy();

    expect(await focusMoves(() => copyText("x"))).toEqual([]);
    expect(document.activeElement).toBe(button);
    expect(document.getSelection()?.toString()).toBe("Some text on the page");
  });

  it.each([
    ["the dialog itself (a click on its text, or Safari's click on a button)", ".MuiDialog-container"],
    ["its copy button", "#copy"],
  ])(
    "copies inside a dialog's focus trap with the focus on %s, which never moves",
    async (_where, focused) => {
      render(
        <Dialog open>
          <DialogContent>
            <p>The map address</p>
            <button id="copy">Copy</button>
          </DialogContent>
        </Dialog>
      );
      const target = document.querySelector(focused) as HTMLElement;
      target.focus();
      expect(document.activeElement).toBe(target);
      const copied = recordingCopy();

      let result: boolean | undefined;
      const moves = await focusMoves(async () => {
        result = await copyText("https://example.org/map");
      });

      expect(result).toBe(true);
      expect(copied).toEqual(["https://example.org/map"]);
      expect(moves).toEqual([]);
      expect(document.activeElement).toBe(target);
    }
  );
});
