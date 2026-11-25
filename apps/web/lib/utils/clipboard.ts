/**
 * Copies text to the clipboard, the one way every copy button in the app does it.
 *
 * The Clipboard API exists only in a secure context (https, or localhost). GOAT on plain http, as a self-hosted
 * install inside a network may run, has none, so the text is then copied the older way: selected on the page and
 * copied with `execCommand("copy")`, which also covers the API refusing (no permission, the page not focused).
 *
 * The older way never moves the focus: a dialog's or a menu's focus trap would take it back, and with it what was
 * selected, while `execCommand` still answered true. The text goes into a hidden span inside the element that holds
 * the focus, or beside it when that element cannot show it (so inside any trap), and is selected with a range; the
 * copy is trusted only when the page's selection is that span and its text. The page's own selection is put back
 * afterwards.
 *
 * @returns whether the value was copied: false for an empty value, and when neither way copied it.
 */
export async function copyText(value: string): Promise<boolean> {
  // Nothing to copy: the clipboard keeps what it holds.
  if (!value) return false;
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard?.writeText && (typeof window === "undefined" || window.isSecureContext !== false)) {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // Refused: the older way may still work.
    }
  }
  return copyBySelection(value);
}

/** Elements whose children are not shown (or that have none), so a span in them cannot be selected: it goes beside
 * them, in the same parent, instead. */
const NO_CHILDREN = new Set([
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "IMG",
  "IFRAME",
  "CANVAS",
  "VIDEO",
  "AUDIO",
  "OBJECT",
  "EMBED",
  "PICTURE",
  "SVG",
  "MATH",
  "BR",
  "HR",
  "METER",
  "PROGRESS",
]);

/** How a browser may give back selected text: other line ends, a no-break space as a space, the last line breaks
 * left out (Chrome drops the one that ends a selected span). */
const comparable = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\n+$/, "");

type TextField = HTMLInputElement | HTMLTextAreaElement;
type FieldSelection = [number, number, "forward" | "backward" | "none"];

/** A focused text field's own selection, which moving the page's selection takes away. */
function fieldSelectionOf(field: TextField | null): FieldSelection | null {
  try {
    if (!field || field.selectionStart === null || field.selectionEnd === null) return null;
    return [
      field.selectionStart,
      field.selectionEnd,
      (field.selectionDirection ?? "none") as FieldSelection[2],
    ];
  } catch {
    // A field without a text selection (a number or an email input in some browsers).
    return null;
  }
}

function copyBySelection(value: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  // Line breaks only: the selected text would be empty, so a copy could not be told from no copy.
  if (!comparable(value)) return false;
  const selection = document.getSelection();
  if (!selection) return false;
  // Copies: the selection's own ranges change with it.
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index).cloneRange()
  );

  const focused = document.activeElement instanceof Element ? document.activeElement : null;
  const field =
    focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
  const fieldSelection = fieldSelectionOf(field);

  const span = document.createElement("span");
  span.textContent = value;
  span.setAttribute("aria-hidden", "true");
  // Rendered but unseen (what is not rendered cannot be selected), selectable inside a button that is not, the lines
  // kept as they are.
  Object.assign(span.style, {
    position: "fixed",
    top: "0",
    left: "0",
    opacity: "0",
    pointerEvents: "none",
    whiteSpace: "pre",
    userSelect: "text",
    webkitUserSelect: "text",
  });

  try {
    // Inside the focused element, so inside any focus trap; beside it when it cannot show the span.
    if (!focused || focused === document.body) document.body.appendChild(span);
    else if (NO_CHILDREN.has(focused.tagName.toUpperCase()) || (focused as HTMLElement).isContentEditable) {
      if (focused.parentNode) focused.after(span);
      else document.body.appendChild(span);
    } else focused.appendChild(span);

    const range = document.createRange();
    range.selectNodeContents(span);
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(span);
    if (!selected || comparable(selection.toString()) !== comparable(value)) return false;
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    span.remove();
    selection.removeAllRanges();
    for (const range of ranges) selection.addRange(range);
    if (field && fieldSelection) {
      try {
        field.setSelectionRange(...fieldSelection);
      } catch {
        // The field changed under the copy: its selection stays as the browser left it.
      }
    }
  }
}
