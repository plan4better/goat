import { type UIMessage, type UIMessageChunk, readUIMessageStream } from "ai";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURES = path.join(__dirname, "fixtures");
const MESSAGE_ID = "0b3c6f0e-6a1d-4b8f-9a77-1d2f3e4a5b6c";

/** Split an SSE body into the JSON chunks the AI SDK transport would deliver. */
function chunksOf(name: string): UIMessageChunk[] {
  const body = readFileSync(path.join(FIXTURES, `${name}.sse`), "utf8");
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice("data: ".length)) as UIMessageChunk);
}

async function finalMessage(chunks: UIMessageChunk[]): Promise<UIMessage> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream, terminateOnError: true })) {
    last = message;
  }
  if (!last) throw new Error("stream produced no message");
  return last;
}

/** Every message state the parser yields, up to an error: what `useChat` has shown by then. */
async function messagesUntilError(chunks: UIMessageChunk[]): Promise<UIMessage[]> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });
  const seen: UIMessage[] = [];
  try {
    for await (const message of readUIMessageStream({ stream, terminateOnError: true })) {
      seen.push(message);
    }
  } catch {
    // the failed fixture ends with an error chunk
  }
  return seen;
}

describe("assistant stream contract (spec §6.2)", () => {
  it("keeps the server message id and joins text deltas", async () => {
    const message = await finalMessage(chunksOf("text_only"));
    expect(message.id).toBe(MESSAGE_ID);
    const text = message.parts.find((part) => part.type === "text");
    expect(text).toMatchObject({ type: "text", text: "Three datasets match." });
  });

  it("keeps the run the start names next to the usage in the message metadata", async () => {
    // The dock's Undo of a live answer names its run.
    const message = await finalMessage(chunksOf("text_only"));
    expect(message.metadata).toMatchObject({
      run_id: "5d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a",
      usage: { model: "test", input_tokens: 10 },
    });
  });

  it("renders tool calls as dynamic tools and data parts by name", async () => {
    const message = await finalMessage(chunksOf("tool_and_proposal"));
    const tool = message.parts.find((part) => part.type === "dynamic-tool");
    expect(tool).toMatchObject({
      toolName: "catalog_search",
      toolCallId: "call-1",
      state: "output-available",
      input: { q: "radverkehr" },
      output: { numberMatched: 3 },
    });
    const proposal = message.parts.find((part) => part.type === "data-proposal");
    expect(proposal).toMatchObject({
      id: `${MESSAGE_ID}:1`,
      data: { title: "Put these on the page" },
    });
  });

  it("surfaces an approval request on the tool part", async () => {
    const message = await finalMessage(chunksOf("approval"));
    const tool = message.parts.find((part) => part.type === "dynamic-tool");
    expect(tool).toMatchObject({ toolCallId: "call-9", state: "approval-requested" });
  });

  it("ends a stopped or failed run with the run-status part a reloaded message has", async () => {
    const cancelled = await finalMessage(chunksOf("cancelled"));
    expect(cancelled.parts.find((part) => part.type === "text")).toMatchObject({ text: "Partial" });
    expect(cancelled.parts.at(-1)).toEqual({
      type: "data-run-status",
      data: { status: "cancelled", error: null, code: null },
    });

    const failedChunks = chunksOf("failed");
    expect(failedChunks.at(-1)?.type).toBe("error");
    await expect(finalMessage(failedChunks)).rejects.toThrow();
    const shown = await messagesUntilError(failedChunks);
    expect(shown.at(-1)?.parts.at(-1)).toMatchObject({
      type: "data-run-status",
      data: { status: "failed", code: "provider_unreachable" },
    });
  });

  it("carries usage as message metadata", async () => {
    const message = await finalMessage(chunksOf("text_only"));
    expect(message.metadata).toMatchObject({
      usage: { model: "test", input_tokens: 10, output_tokens: 4 },
    });
  });

  it("replaying a stream yields the same message as the live one", async () => {
    const live = await finalMessage(chunksOf("tool_and_proposal"));
    const replayed = await finalMessage(chunksOf("tool_and_proposal"));
    expect(replayed).toEqual(live);
  });
});
