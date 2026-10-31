import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_CONTEXT_BYTES, contextBytes } from "@/lib/assistant/chips";
import { registerSurface, resetAssistantStore } from "@/lib/assistant/store";
import type { PageContext } from "@/lib/assistant/types";

import Composer, { MAX_MESSAGE_CHARS } from "@/components/assistant/Composer";
import SourcePicker, { SEARCH_DEBOUNCE_MS } from "@/components/assistant/SourcePicker";
import { MAX_SOURCES, MAX_SOURCE_NAME, useComposerContext } from "@/components/assistant/useComposerContext";

const { useProjectsMock } = vi.hoisted(() => ({
  useProjectsMock: vi.fn((_params?: unknown) => ({
    projects: {
      items: [
        { id: "p2", name: "Berlin" },
        { id: "p1", name: "Current" },
      ],
    },
    isLoading: false,
  })),
}));
vi.mock("@/lib/api/projects", () => ({ useProjects: (params: unknown) => useProjectsMock(params) }));
const { feedback } = vi.hoisted(() => ({ feedback: { href: null as string | null } }));
vi.mock("@/components/support/SupportMenu", () => ({ useReportProblemHref: () => feedback.href }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const base = {
  onSend: vi.fn(),
  busy: false,
  chips: [],
  onRemoveChip: vi.fn(),
  mentionsEnabled: true,
  excludeProjectId: "p1",
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  feedback.href = null;
});

describe("Composer", () => {
  it("caps the message at the length the server accepts", () => {
    // MAX_MESSAGE_CHARS in apps/assistant routers/conversations.py; a longer one would be refused as invalid.
    expect(MAX_MESSAGE_CHARS).toBe(32768);
    render(<Composer {...base} draft="" onDraftChange={vi.fn()} onAddSource={vi.fn()} />);
    const box = screen.getByRole("textbox", { name: "assistant_composer_placeholder" });
    expect(box.getAttribute("maxlength")).toBe("32768");
  });

  it("adds a project source from an @ mention and removes the typed token", () => {
    const onAddSource = vi.fn();
    const onDraftChange = vi.fn();
    render(
      <Composer
        {...base}
        draft="Vergleiche mit @ber"
        onDraftChange={onDraftChange}
        onAddSource={onAddSource}
      />
    );
    expect(screen.queryByText("Current")).toBeNull();
    fireEvent.click(screen.getByText("Berlin"));
    expect(onAddSource).toHaveBeenCalledWith({ kind: "project", id: "p2", name: "Berlin" });
    expect(onDraftChange).toHaveBeenCalledWith("Vergleiche mit ");
  });

  it("offers no mentions where project tools are not loaded", () => {
    render(
      <Composer
        {...base}
        mentionsEnabled={false}
        draft="mail@example"
        onDraftChange={vi.fn()}
        onAddSource={vi.fn()}
      />
    );
    expect(screen.queryByText("assistant_add_source")).toBeNull();
    expect(screen.queryByText("Berlin")).toBeNull();
  });

  it("offers no further sources once the message carries the most it may", () => {
    render(<Composer {...base} sourcesFull draft="und @ber" onDraftChange={vi.fn()} onAddSource={vi.fn()} />);
    expect(screen.queryByText("Berlin")).toBeNull();
    const chip = screen.getByText("assistant_add_source").closest(".MuiChip-root") as HTMLElement;
    expect(chip.className).toContain("Mui-disabled");
    fireEvent.click(chip);
    expect(screen.queryByText("Berlin")).toBeNull();
  });

  it("sends on Enter and keeps Shift+Enter for a new line", () => {
    const onSend = vi.fn();
    render(
      <Composer {...base} onSend={onSend} draft="Hallo" onDraftChange={vi.fn()} onAddSource={vi.fn()} />
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("keeps Send next to Stop while an answer runs when the parent queues", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(
      <Composer
        {...base}
        busy
        queueWhileBusy
        onSend={onSend}
        onStop={onStop}
        draft="Danach"
        onDraftChange={vi.fn()}
        onAddSource={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "assistant_send" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("asks for a question in one short placeholder, with or without mentions", () => {
    for (const mentionsEnabled of [true, false]) {
      const { unmount } = render(
        <Composer
          {...base}
          mentionsEnabled={mentionsEnabled}
          draft=""
          onDraftChange={vi.fn()}
          onAddSource={vi.fn()}
        />
      );
      expect(screen.getByRole("textbox").getAttribute("placeholder"), String(mentionsEnabled)).toBe(
        "assistant_composer_placeholder"
      );
      unmount();
    }
  });

  it("puts the note above the box, with Feedback where a problem can be reported", () => {
    feedback.href = "/support/new?from=%2Fhome";
    render(<Composer {...base} draft="" onDraftChange={vi.fn()} onAddSource={vi.fn()} />);
    const note = screen.getByText("assistant_scope_note");
    const box = screen.getByRole("textbox");
    expect(note.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const link = screen.getByRole("link", { name: "assistant_feedback_link" });
    expect(link.getAttribute("href")).toBe("/support/new?from=%2Fhome");
    // On the same line as the note.
    expect(link.parentElement).toBe(note.parentElement);
  });

  it("opens the ticket form in a new tab, so the dock stays beside the answer being reported", () => {
    feedback.href = "/support/new?from=%2Fmap%2Fp1";
    render(<Composer {...base} draft="" onDraftChange={vi.fn()} onAddSource={vi.fn()} />);
    const link = screen.getByRole("link", { name: "assistant_feedback_link" });
    expect(link.getAttribute("href")).toBe("/support/new?from=%2Fmap%2Fp1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("hands the support email to the mail client without opening a tab", () => {
    feedback.href = "mailto:support@example.com";
    render(<Composer {...base} draft="" onDraftChange={vi.fn()} onAddSource={vi.fn()} />);
    const link = screen.getByRole("link", { name: "assistant_feedback_link" });
    expect(link.getAttribute("href")).toBe("mailto:support@example.com");
    expect(link.getAttribute("target")).toBeNull();
  });

  it("leaves Feedback out where there is no ticket form and no support email", () => {
    feedback.href = null;
    render(<Composer {...base} draft="" onDraftChange={vi.fn()} onAddSource={vi.fn()} />);
    expect(screen.getByText("assistant_scope_note")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("puts the context chips and the source chip in one wrapping row", () => {
    render(
      <Composer
        {...base}
        chips={[
          { key: "target", label: "Radnetz", kind: "target", removable: false },
          { key: "viewport", label: "Map view", kind: "page", removable: true },
        ]}
        draft=""
        onDraftChange={vi.fn()}
        onAddSource={vi.fn()}
      />
    );
    const group = screen.getByRole("group", { name: "assistant_context_label" });
    const chip = (label: string) => screen.getByText(label).closest(".MuiChip-root");
    expect(chip("Radnetz")?.parentElement).toBe(group);
    expect(chip("Map view")?.parentElement).toBe(group);
  });

  it("shows Stop alone while an answer runs and nothing is typed", () => {
    render(
      <Composer
        {...base}
        busy
        queueWhileBusy
        onStop={vi.fn()}
        draft="  "
        onDraftChange={vi.fn()}
        onAddSource={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "assistant_send" })).toBeNull();
  });

  it("takes the focus when asked, with the caret after the text", () => {
    const { rerender } = render(
      <Composer {...base} draft="Build a workflow that " onDraftChange={vi.fn()} onAddSource={vi.fn()} />
    );
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(box);
    rerender(
      <Composer
        {...base}
        draft="Build a workflow that "
        focusRequest={1}
        onDraftChange={vi.fn()}
        onAddSource={vi.fn()}
      />
    );
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe("Build a workflow that ".length);
  });

  it("sends nothing while busy otherwise", () => {
    const onSend = vi.fn();
    render(
      <Composer {...base} busy onSend={onSend} draft="Hallo" onDraftChange={vi.fn()} onAddSource={vi.fn()} />
    );
    expect((screen.getByRole("button", { name: "assistant_send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("SourcePicker", () => {
  it("searches projects once typing pauses", () => {
    vi.useFakeTimers();
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    render(<SourcePicker anchorEl={anchor} query="" onPick={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "assistant_source_search" });
    for (const value of ["r", "ra", "rad"]) fireEvent.change(input, { target: { value } });
    const searched = () =>
      useProjectsMock.mock.calls.map(([params]) => (params as { search?: string }).search);
    expect(searched()).not.toContain("r");
    expect(searched()).not.toContain("rad");
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(searched()).toContain("rad");
    expect(searched()).not.toContain("ra");
  });
});

describe("useComposerContext", () => {
  it("cuts source names to the length the server takes and stops at the most sources", () => {
    resetAssistantStore();
    const { result } = renderHook(() => useComposerContext());
    const long = `${"a".repeat(MAX_SOURCE_NAME - 1)}😀😀 `;
    act(() => result.current.addSource({ kind: "project", id: "p0", name: `  ${long}` }));
    const sources = () => (result.current.context as { sources?: { name: string }[] } | null)?.sources ?? [];
    expect(Array.from(sources()[0].name)).toHaveLength(MAX_SOURCE_NAME);
    expect(sources()[0].name.endsWith("😀")).toBe(true);
    for (let n = 1; n <= MAX_SOURCES; n += 1) {
      act(() => result.current.addSource({ kind: "project", id: `p${n}`, name: `P${n}` }));
    }
    expect(sources()).toHaveLength(MAX_SOURCES);
    expect(result.current.sourcesFull).toBe(true);
  });

  it("keeps the whole body context, sources included, within the size the server accepts", () => {
    resetAssistantStore();
    // A catalog page whose own context alone is close to the limit.
    const facets = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `facet_${i}`,
        Array.from({ length: 5 }, (_, j) => `${j}ä`.padEnd(200, "ü")),
      ])
    );
    const page: PageContext = { surface: "catalog", q: "rad", facets };
    expect(contextBytes(page)).toBeLessThan(MAX_CONTEXT_BYTES);
    registerSurface({ surface: "catalog", getContext: () => page });
    const { result } = renderHook(() => useComposerContext());
    expect(result.current.context).toEqual(page);
    for (let n = 0; n < MAX_SOURCES; n += 1) {
      act(() =>
        result.current.addSource({
          kind: "project",
          id: `00000000-0000-4000-8000-00000000000${n}`,
          name: "ä".repeat(MAX_SOURCE_NAME),
        })
      );
    }
    const context = result.current.context as { facets?: Record<string, string[]>; sources?: unknown[] };
    expect(contextBytes(context as PageContext)).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
    expect(context.sources).toHaveLength(MAX_SOURCES);
    expect(Object.keys(context.facets ?? {}).length).toBeLessThan(8);
  });
});
