"""Capability profile of a connection's model (spec §4.3).

Context window, prompt caching and strict schemas come from Pydantic AI's
model profile, which knows the common model families. Vision has no profile
field, so it is known for a few families and unknown (None) otherwise. The
probe adds what it observed (tool calling, streaming).
"""

import json
from pathlib import Path
from typing import Any

from pydantic_ai.models import Model

_VISION_FAMILIES = ("claude", "gpt-4o", "gpt-4.1", "gpt-5")

_TESTED_FILE = Path(__file__).with_name("tested_models.json")


def _load_tested() -> frozenset[tuple[str, str]]:
    data = json.loads(_TESTED_FILE.read_text())
    return frozenset(
        (str(item["provider"]), str(item["model"])) for item in data["models"]
    )


#: (provider, model) pairs that passed the eval set.
TESTED_MODELS: frozenset[tuple[str, str]] = _load_tested()


def capabilities_for(model: Model, model_name: str) -> dict[str, Any]:
    profile = model.profile
    name = model_name.lower()
    return {
        "vision": True if any(family in name for family in _VISION_FAMILIES) else None,
        "context_window": profile.get("context_window"),
        "prompt_caching": profile.get("default_cache_retention") is not None,
        "strict_schemas": bool(profile.get("supports_json_schema_output", False)),
    }


def is_tested(provider: str, model: str) -> bool:
    return (provider, model) in TESTED_MODELS
