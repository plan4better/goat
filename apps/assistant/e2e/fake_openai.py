"""A fake OpenAI-compatible model for the assistant's end-to-end test (decision E18).

Speaks just enough of the Chat Completions API: POST /v1/chat/completions,
streamed (server-sent events) or not, and GET /v1/models. Scripted: when the
last message comes from the user and the request offers the catalog filter
tool, it calls that tool; once the tool result is in, it answers with a fixed
text. A request without tools (a conversation title) gets a short title.

    python3 apps/assistant/e2e/fake_openai.py --port 8599
"""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MODEL = "goat-e2e-fake"
TOOL = "catalog_propose_filters"
ARGUMENTS: dict[str, Any] = {
    "title": "Radverkehr",
    "q": "Radverkehr",
    "facets": {"themes": ["transportation"]},
}
ANSWER = "I set the catalog to cycling data in the transportation category."
TITLE = "Cycling data"
USAGE = {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20}


def reply(body: dict[str, Any]) -> tuple[str | None, dict[str, str] | None]:
    """The scripted turn: (text, None) or (None, a tool call)."""
    tools = [tool.get("function", {}).get("name") for tool in body.get("tools") or []]
    if not tools:
        return TITLE, None
    messages = body.get("messages") or []
    last = messages[-1] if messages else {}
    if last.get("role") == "user" and TOOL in tools:
        return None, {
            "id": "call_e2e_1",
            "name": TOOL,
            "arguments": json.dumps(ARGUMENTS),
        }
    return ANSWER, None


def _envelope(kind: str) -> dict[str, Any]:
    return {
        "id": "chatcmpl-e2e",
        "object": kind,
        "created": int(time.time()),
        "model": MODEL,
    }


def _completion(text: str | None, call: dict[str, str] | None) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": text}
    if call is not None:
        message["tool_calls"] = [
            {
                "id": call["id"],
                "type": "function",
                "function": {"name": call["name"], "arguments": call["arguments"]},
            }
        ]
    finish = "tool_calls" if call is not None else "stop"
    return {
        **_envelope("chat.completion"),
        "usage": USAGE,
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
    }


def _chunks(
    text: str | None, call: dict[str, str] | None, include_usage: bool
) -> list[dict[str, Any]]:
    def chunk(delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
        return {
            **_envelope("chat.completion.chunk"),
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }

    chunks = [chunk({"role": "assistant", "content": ""})]
    if call is not None:
        chunks.append(
            chunk(
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call["id"],
                            "type": "function",
                            "function": {"name": call["name"], "arguments": ""},
                        }
                    ]
                }
            )
        )
        chunks.append(
            chunk(
                {
                    "tool_calls": [
                        {"index": 0, "function": {"arguments": call["arguments"]}}
                    ]
                }
            )
        )
        chunks.append(chunk({}, "tool_calls"))
    else:
        for index, word in enumerate((text or "").split(" ")):
            chunks.append(chunk({"content": word if index == 0 else f" {word}"}))
        chunks.append(chunk({}, "stop"))
    if include_usage:
        chunks.append(
            {**_envelope("chat.completion.chunk"), "choices": [], "usage": USAGE}
        )
    return chunks


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/v1/models":
            self._json(
                200,
                {
                    "object": "list",
                    "data": [{"id": MODEL, "object": "model", "owned_by": "goat-e2e"}],
                },
            )
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/v1/chat/completions":
            self._json(404, {"error": {"message": "not found"}})
            return
        length = int(self.headers.get("Content-Length", "0"))
        body: dict[str, Any] = json.loads(self.rfile.read(length) or b"{}")
        text, call = reply(body)
        if not body.get("stream"):
            self._json(200, _completion(text, call))
            return
        include_usage = bool((body.get("stream_options") or {}).get("include_usage"))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for item in _chunks(text, call, include_usage):
            self.wfile.write(f"data: {json.dumps(item)}\n\n".encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def make_server(port: int = 0) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8599)
    server = make_server(parser.parse_args().port)
    print(
        f"fake OpenAI model {MODEL} on http://127.0.0.1:{server.server_address[1]}/v1",
        flush=True,
    )
    server.serve_forever()
