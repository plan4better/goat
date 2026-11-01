"""What every deployment target relies on from the image (spec §13).

The graceful-shutdown contract spans three files in this repository: the
image stops waiting for open streams after UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN,
and each target must give the process longer than that before it kills it,
or the lifespan shutdown (run bookkeeping, bus, pool) is cut off.
"""

import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DOCKERFILE = ROOT / "apps" / "assistant" / "Dockerfile"
COMPOSE = ROOT / "deploy" / "compose" / "compose.yaml"
HELM_VALUES = ROOT / "deploy" / "helm" / "goat" / "values.yaml"
PYPROJECT = ROOT / "apps" / "assistant" / "pyproject.toml"

#: What the lifespan shutdown needs after uvicorn stopped waiting for streams.
LIFESPAN_BUDGET_SECONDS = 5


def _graceful_shutdown_seconds() -> int:
    match = re.search(
        r"^ENV UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN=(\d+)$", DOCKERFILE.read_text(), re.M
    )
    assert match, "the Dockerfile must set UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN"
    return int(match.group(1))


def _block(text: str, header: str) -> str:
    """The lines under a YAML key at the given indentation, up to the next sibling."""
    indent = len(header) - len(header.lstrip())
    lines = text.splitlines()
    start = lines.index(header) + 1
    block: list[str] = []
    for line in lines[start:]:
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            break
        block.append(line)
    return "\n".join(block)


def test_image_serves_on_8500_from_the_package() -> None:
    text = DOCKERFILE.read_text()
    cmd = json.loads(re.search(r"^CMD (\[.*\])$", text, re.M).group(1))  # type: ignore[union-attr]
    assert cmd == [
        "uvicorn",
        "assistant.main:app",
        "--host",
        "0.0.0.0",
        "--port",
        "8500",
    ]
    assert re.search(r"^EXPOSE 8500$", text, re.M)
    assert re.search(r"^USER appuser$", text, re.M)


def test_image_drains_streams_before_the_platform_kills_it() -> None:
    drain = _graceful_shutdown_seconds()
    compose = _block(COMPOSE.read_text(), "  assistant:")
    stop = re.search(r"^    stop_grace_period: (\d+)s$", compose, re.M)
    assert stop, "the compose assistant service must set stop_grace_period"
    helm = _block(HELM_VALUES.read_text(), "assistant:")
    grace = re.search(r"^  terminationGracePeriodSeconds: (\d+)$", helm, re.M)
    assert grace, "values.yaml assistant must set terminationGracePeriodSeconds"
    for name, seconds in (
        ("compose", int(stop.group(1))),
        ("helm", int(grace.group(1))),
    ):
        assert seconds >= drain + LIFESPAN_BUDGET_SECONDS, name


def test_wheel_leaves_out_the_fixture_generator() -> None:
    config = tomllib.loads(PYPROJECT.read_text())
    wheel = config["tool"]["hatch"]["build"]["targets"]["wheel"]
    assert "src/assistant/encoding/fixtures.py" in wheel["exclude"]
