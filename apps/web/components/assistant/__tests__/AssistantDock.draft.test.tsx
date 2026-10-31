import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetAssistantStore, setDockState } from "@/lib/assistant/store";

import AssistantDock from "@/components/assistant/AssistantDock";

// The real NewConversation and composer; only the network and the history are stubbed.
vi.mock("@/hooks/store/ContextHooks", () => ({ useAppDispatch: () => vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/home" }));
vi.mock("react-toastify", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/lib/assistant/conversations", () => ({
  useConversations: () => ({ conversations: [], isLoading: false }),
  updateConversation: vi.fn(),
  refreshConversationLists: vi.fn(),
}));
vi.mock("@/lib/assistant/transport", () => ({
  createAssistantTransport: vi.fn(),
  cancelAssistantRun: vi.fn(),
  fetchConversation: vi.fn(),
  createConversation: vi.fn(),
}));
vi.mock("@/lib/api/projects", () => ({
  useProjects: () => ({ projects: { items: [] }, isLoading: false }),
  useProjectLayers: () => ({ layers: undefined }),
}));
vi.mock("@/components/assistant/ConversationHistory", () => ({
  default: () => <div data-testid="history" />,
}));
// The composer's Feedback link reads the support summary; not under test here.
vi.mock("@/components/support/SupportMenu", () => ({ useReportProblemHref: () => null }));
// The start page's AI notice links the privacy policy only with NEXT_PUBLIC_WEBSITE_URL, through
// `Trans`, which this i18n mock has not: without the link, these tests do not depend on that variable.
vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  privacyPolicyUrl: () => undefined,
}));
vi.mock("@/components/addLayer/AddLayerDialog", () => ({ default: () => null }));

const composerValue = () => (screen.getByRole("textbox", { name: /assistant/ }) as HTMLTextAreaElement).value;

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  setDockState({ enabled: true, open: true });
});

describe("AssistantDock expand and collapse", () => {
  it("keeps the typed text of a new conversation when the panel expands and collapses", () => {
    const { rerender } = render(<AssistantDock variant="docked" />);
    fireEvent.change(screen.getByRole("textbox", { name: /assistant/ }), {
      target: { value: "Wo gibt es Radwege?" },
    });
    rerender(<AssistantDock variant="fullscreen" />);
    expect(composerValue()).toBe("Wo gibt es Radwege?");
    rerender(<AssistantDock variant="docked" />);
    expect(composerValue()).toBe("Wo gibt es Radwege?");
  });
});
