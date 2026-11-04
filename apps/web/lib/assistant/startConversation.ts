import { refreshConversationLists } from "@/lib/assistant/conversations";
import { openConversation, setFirstMessage } from "@/lib/assistant/store";
import { createConversation } from "@/lib/assistant/transport";
import type { PageContext } from "@/lib/assistant/types";

/**
 * Creates a conversation and opens it in the dock with `text` as its first
 * message, which its chat view sends once mounted. Used by the dock's new
 * conversation and by the Home search's "Ask AI". It is created unbound, also
 * on a project page: the server binds it when it accepts the first run, so a
 * refused first message binds nothing. Throws when the conversation could not
 * be created; nothing is opened then.
 */
export async function startConversation(
  text: string,
  { origin, context }: { origin: string; context: PageContext | null }
): Promise<string> {
  const created = await createConversation(origin);
  setFirstMessage({ conversationId: created.id, text, context });
  void refreshConversationLists();
  openConversation(created.id);
  return created.id;
}
