from dataclasses import dataclass

from assistant.bus import EventBus
from assistant.db import Database
from assistant.repo import Repository
from assistant.runs.manager import RunManager
from assistant.tools.http import ServiceClients


@dataclass
class AppServices:
    db: Database
    repo: Repository
    bus: EventBus
    runs: RunManager
    #: The clients GOAT's tools call (closed with the app); None in tests that
    #: run without tools.
    tools: ServiceClients | None = None
