"""Waiting for a file another pod has just written to the shared data volume.

On NFS every node remembers for a while that a name did not exist, and answers
later lookups from that memory instead of asking the server. A file written a
moment ago by a job on another node (a catalog layer's copy, a workflow step's
result) can therefore look missing here for up to the client's cache timeout,
and then appear. Where the caller knows the file must exist, it waits for it
instead of concluding it is gone; where it does not, it must not wait.
"""

import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")

#: How long a file known to exist may take to appear: longer than the NFS
#: client's directory cache and the server's delegation recall.
WAIT_SECONDS = 90.0
#: How often to look again meanwhile.
POLL_SECONDS = 2.0


def wait_for(
    find: Callable[[], T | None],
    *,
    timeout: float | None = None,
    interval: float | None = None,
) -> T | None:
    """`find()`'s first non-None answer, asking again until `timeout` passes.

    Returns at once when the file is there already; None when it never appears.
    """
    timeout = WAIT_SECONDS if timeout is None else timeout
    interval = POLL_SECONDS if interval is None else interval
    deadline = time.monotonic() + timeout
    while True:
        found = find()
        if found is not None:
            return found
        left = deadline - time.monotonic()
        if left <= 0:
            return None
        time.sleep(min(interval, left))
