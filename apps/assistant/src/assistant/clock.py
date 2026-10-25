"""The answer's one clock (spec 2026-10-23 §5).

An answer may take ``run_max_seconds`` from its start (``asyncio.timeout`` in
``RunManager``). A tool that waits for a workflow run moves that deadline to
``run_wait_max_seconds`` from the answer's start, never earlier than it was,
and reads how much time is left to end its wait in time for the answer.
"""

import asyncio


class AnswerClock:
    def __init__(self, wait_max_seconds: float) -> None:
        self.started = asyncio.get_running_loop().time()
        self.wait_max_seconds = wait_max_seconds
        #: The answer's deadline, set by the run once it entered its timeout.
        self.timeout: asyncio.Timeout | None = None

    def extend(self) -> None:
        """Lets the answer run until its start plus ``wait_max_seconds``."""
        if self.timeout is None:
            return
        target = self.started + self.wait_max_seconds
        when = self.timeout.when()
        if when is not None and when < target:
            self.timeout.reschedule(target)

    def remaining(self) -> float | None:
        """Seconds until the answer's deadline; None without one."""
        if self.timeout is None:
            return None
        when = self.timeout.when()
        if when is None:
            return None
        return when - asyncio.get_running_loop().time()
