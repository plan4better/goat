"""A stand-in for the Windmill client calls `workflow_runner` makes.

The runner starts every step with `wmill.run_script_async(path, args=...)`
and waits with `wmill.get_job_status` and `wmill.get_result`.
`InProcessWindmill` runs the job at once, in this process, through the script
sync writes at that path (`sync_windmill.windmill_script`), so a tool's
generated wrapper handles the arguments as it does on a worker. Arguments and
results pass through JSON, as between Windmill and a job. `main` gets its
arguments the way Windmill's Python wrapper binds them
(`windmill_arguments`): the runner sends finalize a `delete_temp` its script
does not take. A job that raises completes with status COMPLETED and
`{"error": {...}}` as its result, the error as that wrapper records it
(`failed_job_error`), which is what Windmill returns for a failed job.
"""

import inspect
import json
import traceback
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from goatlib.tools.sync_windmill import windmill_script


@dataclass
class Job:
    path: str
    args: dict[str, Any]
    result: Any


def windmill_arguments(
    main: Callable[..., Any], args: dict[str, Any]
) -> dict[str, Any]:
    """The arguments Windmill passes `main`: all of them, as sent, when it
    takes `**kwargs`. Otherwise each name its signature declares: a required
    one as sent (None when not sent), one with a default only when sent and
    not None, so that its default applies."""
    parameters = inspect.signature(main).parameters.values()
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters):
        return args
    bound: dict[str, Any] = {}
    for parameter in parameters:
        value = args.get(parameter.name)
        if parameter.default is inspect.Parameter.empty or value is not None:
            bound[parameter.name] = value
    return bound


def failed_job_error(error: BaseException) -> dict[str, Any]:
    """A failed job's error as Windmill's Python wrapper records it: the
    exception's text and type name, the stack without the wrapper's own
    frame (here the stand-in's call of `main`), and the exception's
    attributes under `extra` when it has any."""
    recorded: dict[str, Any] = {
        "message": str(error),
        "name": type(error).__name__,
        "stack": "\n".join(traceback.format_tb(error.__traceback__)[1:]),
    }
    extra = getattr(error, "__dict__", None)
    if extra:
        recorded["extra"] = extra
    return recorded


@dataclass
class InProcessWindmill:
    #: Every job run so far, by job id, in the order they finished.
    jobs: dict[str, Job] = field(default_factory=dict)

    def run_script_async(
        self, path: str, args: dict[str, Any] | None = None, **_: Any
    ) -> str:
        sent = json.loads(json.dumps(args or {}))
        namespace: dict[str, Any] = {}
        exec(compile(windmill_script(path), path, "exec"), namespace)
        main = namespace["main"]
        try:
            result = main(**windmill_arguments(main, sent))
        except Exception as error:
            result = {"error": failed_job_error(error)}
        job_id = str(uuid.uuid4())
        self.jobs[job_id] = Job(path, sent, json.loads(json.dumps(result, default=str)))
        return job_id

    def get_job_status(self, job_id: str) -> str:
        return "COMPLETED"

    def get_result(self, job_id: str, *_: Any) -> Any:
        return self.jobs[job_id].result
