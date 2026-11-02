"""A fake Windmill workspace for the script syncs' tests (tools and tasks).

It holds scripts and schedules by path and answers the calls the syncs make
as Windmill 1.751 does: a script it does not hold is a 404 with a plain-text
body, a create answers 201 with the new hash as text, and a script it wrote
reads back in the shape of ``BUFFER_AS_READ``, with the dependency job done.
"""

import json
from itertools import count
from typing import Any

import httpx

API = "/api/w/goat/"

#: What ``GET /api/w/goat/scripts/get/p/f/goat/tools/buffer`` returned on
#: Windmill 1.751 (dev-02, 2026-11-02) for the script the tools sync wrote,
#: after the dependency job ran. Sanitized: ``content`` left out (a test sets
#: it), ``created_by`` replaced.
BUFFER_AS_READ: dict[str, Any] = {
    "workspace_id": "goat",
    "hash": "fbdb8a2f651bd4bc",
    "path": "f/goat/tools/buffer",
    "parent_hashes": None,
    "summary": "Buffer",
    "description": "Creates buffer polygons around input features at a "
    "specified distance",
    "created_by": "admin",
    "created_at": "2026-11-01T15:26:31.909613Z",
    "archived": False,
    "schema": None,
    "deleted": False,
    "is_template": False,
    "extra_perms": {},
    "lock": "# py: 3.11\n",
    "lock_error_logs": None,
    "language": "python3",
    "kind": "script",
    "tag": "tools",
    "ws_error_handler_muted": False,
    "assets": [],
    "is_draft": False,
}

#: The same for ``f/goat/tasks/generate_thumbnails``, written by the tasks sync.
GENERATE_THUMBNAILS_AS_READ: dict[str, Any] = {
    **BUFFER_AS_READ,
    "hash": "d7bdd34f355f3fbb",
    "path": "f/goat/tasks/generate_thumbnails",
    "summary": "Generate Thumbnails",
    "description": "Generate thumbnails for projects and layers that have been "
    "updated",
    "created_at": "2026-11-01T19:55:29.850264Z",
    "tag": "print",
}


class FakeWindmill:
    """A Windmill workspace holding ``scripts`` and ``schedules`` by path. It
    records every request, answers a create of a path in ``refuse`` with the
    status and body given there, and every read with ``refuse_reads`` when
    that is set."""

    def __init__(
        self,
        scripts: dict[str, dict[str, Any]] | None = None,
        schedules: dict[str, dict[str, Any]] | None = None,
        refuse: dict[str, tuple[int, str]] | None = None,
        refuse_reads: tuple[int, str] | None = None,
    ) -> None:
        self.scripts = dict(scripts or {})
        self.schedules = dict(schedules or {})
        self.refuse = refuse or {}
        self.refuse_reads = refuse_reads
        self.requests: list[httpx.Request] = []
        self.created: list[dict[str, Any]] = []
        self._hashes = count(1)
        self._history: list[tuple[Any, ...]] = []

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.respond))

    def respond(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path.removeprefix(API)
        if request.method == "GET":
            if self.refuse_reads:
                status, text = self.refuse_reads
                return httpx.Response(status, text=text)
            return self._get(path)
        body = json.loads(request.content) if request.content else {}
        if path == "scripts/create":
            return self._create(body)
        if path == "schedules/create":
            self.schedules[body["path"]] = body
        elif path.startswith("schedules/update/"):
            name = path.removeprefix("schedules/update/")
            self.schedules[name] = {**self.schedules[name], **body}
        return httpx.Response(200, text=body.get("path", ""))

    def _get(self, path: str) -> httpx.Response:
        for prefix, held in (
            ("scripts/get/p/", self.scripts),
            ("schedules/get/", self.schedules),
        ):
            name = path.removeprefix(prefix)
            if path.startswith(prefix) and name in held:
                return httpx.Response(200, json=held[name])
        return httpx.Response(404, text=f"Not found: Script not found at path {path}")

    def _create(self, body: dict[str, Any]) -> httpx.Response:
        if body["path"] in self.refuse:
            status, text = self.refuse[body["path"]]
            return httpx.Response(status, text=text)
        # Windmill hashes a version from what the request sends, its
        # parent_hash included (not the parent auto_parent resolves to), and
        # refuses a second version with the same hash.
        version = _version(body, body.get("parent_hash"))
        if version in self._versions():
            return httpx.Response(
                400,
                text="Bad request: A script with same hash (hence same path, "
                "description, summary, content) already exists!",
            )
        self.created.append(body)
        current = self.scripts.get(body["path"])
        lineage = (
            [current["hash"], *(current["parent_hashes"] or [])] if current else None
        )
        new_hash = f"hash-{next(self._hashes)}"
        fields = {
            k: v for k, v in body.items() if k not in ("auto_parent", "parent_hash")
        }
        self.scripts[body["path"]] = {
            **BUFFER_AS_READ,
            **fields,
            "hash": new_hash,
            "parent_hashes": lineage,
        }
        self._history.append(version)
        return httpx.Response(201, text=new_hash)

    def _versions(self) -> set[tuple[Any, ...]]:
        held = {
            _version(script, (script.get("parent_hashes") or [None])[0])
            for script in self.scripts.values()
        }
        return held | set(self._history)

    def writes(self) -> list[str]:
        """The paths, below the workspace, of every request that wrote."""
        return [
            r.url.path.removeprefix(API) for r in self.requests if r.method != "GET"
        ]


def _version(script: dict[str, Any], parent: str | None) -> tuple[Any, ...]:
    """What Windmill tells two versions of a script apart by."""
    fields = ("path", "content", "summary", "description")
    return (*(script.get(field) for field in fields), parent)
