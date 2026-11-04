"""Write a script to Windmill in place: the step both syncs share
(``goatlib.tools.sync_windmill`` and ``goatlib.tasks.sync_windmill``).

A sync never deletes a script, so its path always resolves to a script and
Windmill keeps the script's version history. It reads the script at the path
and

- creates it when there is none;
- leaves it alone when Windmill holds what the sync would write and can run
  it;
- otherwise deploys a new version on top of the current one: a create at the
  same path with the hash it read as ``parent_hash`` and ``auto_parent``.
  Windmill tells versions apart by the ``parent_hash`` sent, so going back to
  content an earlier version had (undoing a hand edit) needs it; without it
  Windmill refuses the version as one it already has. ``auto_parent`` makes
  Windmill take the version current when it writes as the parent instead, so
  a version deployed since the read (in the UI) does not fail the sync with
  "lineage must be linear".

A new version holds only what the sync sends. Per-script settings made in the
Windmill UI (timeout, concurrency, environment variables) are not carried
over: these scripts are managed from goatlib.

Placed at the top level of goatlib next to ``windmill_init``, since neither
sync owns it.
"""

from collections import Counter
from typing import Any, Literal

import httpx

#: The language every script the syncs write is in.
LANGUAGE = "python3"

#: Every status a sync's result has, in the order its closing log line
#: counts them.
STATUSES = ("synced", "unchanged", "failed", "dry-run")


def deploy_script(
    client: httpx.Client,
    base_url: str,
    workspace: str,
    *,
    path: str,
    content: str,
    summary: str,
    description: str,
    tag: str | None = None,
) -> Literal["synced", "unchanged"]:
    """Make the script at ``path`` the given one, keeping its history.

    Returns "synced" when it wrote a script and "unchanged" when Windmill
    already held it. Raises ``httpx.HTTPStatusError`` with Windmill's answer
    when Windmill refuses the read or the write.
    """
    scripts = f"{base_url}/api/w/{workspace}/scripts"
    script: dict[str, Any] = {
        "path": path,
        "content": content,
        "summary": summary,
        "description": description,
        "language": LANGUAGE,
        "tag": tag,
    }

    current = client.get(f"{scripts}/get/p/{path}")
    if current.status_code != 404:
        _raise_for_status(current)
        deployed = current.json()
        if _same(deployed, script):
            return "unchanged"
        script["parent_hash"] = deployed["hash"]
        script["auto_parent"] = True

    _raise_for_status(client.post(f"{scripts}/create", json=script))
    return "synced"


def summarize(results: list[dict[str, Any]]) -> str:
    """A sync's closing log line, counting its results by status."""
    count = Counter(result["status"] for result in results)
    counted = [f"{count[status]} {status}" for status in STATUSES if count[status]]
    return "Done: " + (", ".join(counted) or "no scripts")


def _same(deployed: dict[str, Any], script: dict[str, Any]) -> bool:
    """Whether Windmill holds the script the sync would write, ready to run.

    Compares every field the sync sends but the path, with "" and None alike.
    A script is also deployed again when it is archived (Windmill then finds
    no script to run at its path), when its dependency job failed
    (``lock_error_logs``), or when it has no lock: a Python script whose
    dependency job ran carries the lock that job wrote.
    """
    ready = (
        not deployed.get("archived")
        and not deployed.get("lock_error_logs")
        and deployed.get("lock")
    )
    return bool(ready) and all(
        (deployed.get(field) or None) == (value or None)
        for field, value in script.items()
        if field != "path"
    )


def _raise_for_status(response: httpx.Response) -> None:
    """``raise_for_status`` with Windmill's reason in the message: its body
    says why it refused (a path conflict, a missing permission)."""
    if response.is_error:
        request = response.request
        raise httpx.HTTPStatusError(
            f"Windmill answered {response.status_code} to {request.method} "
            f"{request.url.path}: {response.text.strip()}",
            request=request,
            response=response,
        )
