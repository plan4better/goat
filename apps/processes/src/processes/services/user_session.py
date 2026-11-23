"""Job inputs for tools that act as the user who started them.

`print_report` renders the web app with the user's token, and its refresh
token from the web app. `project_import` uploads the archive's icons and
images through core's API with the access token, as its first step while the
token is fresh. `project_export` reads them from core's public file route
and needs core's address only. Uploaded files always go through core, never
through the job's own storage access. The server sets the token and core's
address; whatever the caller sent under those names is replaced.
"""

from typing import Any

#: Tools whose job gets the caller's access token.
ACCESS_TOKEN_TOOLS = frozenset({"print_report", "project_import"})
#: Tools whose job calls core's API, and so gets core's address.
CORE_API_TOOLS = frozenset({"project_export", "project_import"})
#: The one tool that takes a refresh token (from the web app).
REFRESH_TOKEN_TOOLS = frozenset({"print_report"})

_SERVER_SET = ("access_token", "core_url")


def user_session_inputs(
    process_id: str,
    inputs: dict[str, Any],
    access_token: str | None,
    core_url: str,
) -> dict[str, Any]:
    """`inputs` with what `process_id`'s job gets of the user's session: the
    access token (ACCESS_TOKEN_TOOLS), core's address (CORE_API_TOOLS) and the
    caller's refresh token (REFRESH_TOKEN_TOOLS). Other tools get none."""
    out = {k: v for k, v in inputs.items() if k not in _SERVER_SET}
    if process_id not in REFRESH_TOKEN_TOOLS:
        out.pop("refresh_token", None)
    if process_id in ACCESS_TOKEN_TOOLS and access_token:
        out["access_token"] = access_token
    if process_id in CORE_API_TOOLS and core_url:
        out["core_url"] = core_url.rstrip("/")
    return out
