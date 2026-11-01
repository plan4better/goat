"""The text of a failed workflow step, as people see it.

A Windmill job that raised stores `{"error": {"name", "message", "stack",
...}}` as its result. The workflow runner lists each failed step with this
reduction of its error, and processes applies the same one to a failed
child job while the run goes on, so a step's error reads the same during
and after a run: the message (the name when there is none), never the stack
or the extra details, cut to a length a step badge and the issue list can
show, without credentials and without local paths. Standard library only,
like the rest of `goatlib.workflows`.
"""

import os
import re
import tempfile

from goatlib.utils.credentials import redact_credentials

MAX_MESSAGE_LENGTH = 500

# Windmill names who cancelled a job ("cancelled by <username>"); the name
# is not shown.
_CANCELLED_BY = re.compile(r"cancelled by \S+")

# An absolute path on the worker, such as a temp result under the user's and
# the workflow's ids that a DuckDB IO error names, also as a `file://` URL. It
# starts at a slash no word, dot, colon, slash or percent sign stands before
# (so the path of a URL, `km/h`, `a/b/c` and a LIKE pattern stay), has two
# names or more, and its first name is one of the worker's top folders (see
# `_LOCAL_ROOTS`), so a relative URL (`/api/...`) and a division (`x /pop/2`)
# stay.
_LOCAL_PATH = re.compile(
    r"(?:\bfile://|(?<![\w.~:/\\%-]))/(?P<root>[A-Za-z_][\w.@+=-]*)" r"(?:/[\w.@+=-]*)+"
)
_LOCAL_PATH_SHOWN_AS = "<path>"


def _top_folder(path: str) -> str | None:
    """The first name of an absolute path, None for anything else."""
    names = path.split("/")
    return names[1] if path.startswith("/") and len(names) > 1 else None


#: The top folders local paths live under: the system's (temp files, the
#: app's data under /app/data, home folders), plus those of the temp folder
#: and the data folders this process is set up with.
_LOCAL_ROOTS = {
    "app",
    "data",
    "home",
    "mnt",
    "opt",
    "private",
    "root",
    "srv",
    "tmp",
    "Users",
    "var",
} | {
    folder
    for folder in (
        _top_folder(value)
        for value in (
            tempfile.gettempdir(),
            *(
                os.environ.get(name, "")
                for name in (
                    "DATA_DIR",
                    "DUCKLAKE_DATA_DIR",
                    "TILES_DATA_DIR",
                    "BUNDLES_DATA_DIR",
                    "CATALOG_LAYERS_DIR",
                )
            ),
        )
    )
    if folder
}


def _hide_local_path(match: re.Match[str]) -> str:
    """`<path>` for a local path, keeping a sentence's full stop after it;
    anything else as it is."""
    path = match.group(0)
    if match.group("root") not in _LOCAL_ROOTS:
        return path
    return _LOCAL_PATH_SHOWN_AS + path[len(path.rstrip(".")) :]


def error_message(error: object) -> str:
    """A step error's message: a Windmill error's `message` (its `name` when
    the message is empty), an exception's text (its type when the text is
    empty), or the text of anything else."""
    if isinstance(error, dict):
        text = str(error.get("message") or error.get("name") or "")
    elif isinstance(error, BaseException):
        text = str(error) or type(error).__name__
    elif error is None:
        text = ""
    else:
        text = str(error)
    text = _CANCELLED_BY.sub("cancelled", text).strip() or "Unknown error"
    text = redact_credentials(text)
    text = _LOCAL_PATH.sub(_hide_local_path, text)
    if len(text) > MAX_MESSAGE_LENGTH:
        text = text[: MAX_MESSAGE_LENGTH - 1] + "…"
    return text


def step_errors(errors: object) -> dict[str, str]:
    """Each failed step's message, keyed by step id, from a run result's
    `errors` list.

    An entry is `{"node_id", "message"}`; an entry holding the raw error
    instead (`{"node_id", "error"}`) is reduced the same way. Entries
    without a step id are left out; the first entry of a step wins.
    """
    found: dict[str, str] = {}
    if not isinstance(errors, list):
        return found
    for entry in errors:
        if not isinstance(entry, dict) or not entry.get("node_id"):
            continue
        raw = entry["message"] if "message" in entry else entry.get("error")
        found.setdefault(str(entry["node_id"]), error_message(raw))
    return found
