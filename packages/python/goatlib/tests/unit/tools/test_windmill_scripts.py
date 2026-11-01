"""The script sync writes to Windmill at a path: a tool's generated wrapper,
or the workflow runner's or finalize step's script. The workflow chain tests
run these scripts in place of Windmill (tests/integration/tools/chains)."""

import inspect
import json
from typing import Any

import httpx
import pytest
from goatlib.tools.buffer import BufferToolParams
from goatlib.tools.codegen import generate_windmill_script
from goatlib.tools.sync_windmill import (
    WORKFLOW_SCRIPTS,
    WindmillSyncer,
    windmill_script,
)

pytestmark = pytest.mark.unit


def test_a_tool_path_gives_its_generated_wrapper() -> None:
    assert windmill_script("f/goat/tools/buffer") == generate_windmill_script(
        "goatlib.tools.buffer", BufferToolParams
    )


def test_a_path_sync_writes_nothing_at_has_no_script() -> None:
    with pytest.raises(KeyError):
        windmill_script("f/goat/tools/no_such_tool")


def _written_by(sync: str) -> dict[str, str]:
    """The scripts a sync writes, by path, against a Windmill that has none."""
    written: dict[str, str] = {}

    def respond(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.content:
            body = json.loads(request.content)
            if isinstance(body, dict) and "path" in body and "content" in body:
                written[body["path"]] = body["content"]
        return httpx.Response(200, json={})

    syncer = WindmillSyncer("http://windmill.test", "token")
    syncer.client = httpx.Client(transport=httpx.MockTransport(respond))
    getattr(syncer, sync)()
    return written


def test_sync_writes_the_workflow_scripts_windmill_script_gives() -> None:
    assert _written_by("sync_workflow_scripts") == dict(WORKFLOW_SCRIPTS)


def test_every_script_sync_writes_is_the_one_windmill_script_gives() -> None:
    written = _written_by("sync_all")
    assert set(WORKFLOW_SCRIPTS) <= set(written)
    assert {path: windmill_script(path) for path in written} == written


def test_the_finalize_script_names_its_arguments_and_takes_no_others() -> None:
    namespace: dict[str, Any] = {}
    script = windmill_script("f/goat/tools/finalize_layer")
    exec(compile(script, "finalize_layer", "exec"), namespace)
    parameters = inspect.signature(namespace["main"]).parameters.values()
    assert "delete_temp" not in {parameter.name for parameter in parameters}
    assert all(
        parameter.kind is not inspect.Parameter.VAR_KEYWORD for parameter in parameters
    )
