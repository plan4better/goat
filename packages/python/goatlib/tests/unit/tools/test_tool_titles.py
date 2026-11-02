"""Every registered tool has a title in the web app.

The jobs list names a job by its tool's id, translated (`lib/utils/jobLabel.ts`
in apps/web); a tool without a translation shows its raw id there. Checked
here, where a tool is added: the registry is the list of what can run.
"""

import json
from pathlib import Path

import pytest
from goatlib.tools.registry import TOOL_REGISTRY

LOCALES = Path(__file__).resolve().parents[6] / "apps" / "web" / "i18n" / "locales"


@pytest.mark.parametrize("language", ["en", "de"])
def test_every_tool_has_a_job_title(language: str) -> None:
    path = LOCALES / language / "common.json"
    if not path.is_file():
        pytest.skip("the web app is not in this checkout")
    texts = json.loads(path.read_text())
    untitled = [
        tool.name
        for tool in TOOL_REGISTRY
        if not isinstance(texts.get(tool.name), str) or not texts[tool.name].strip()
    ]
    assert not untitled, f"no {language} title in {path.name} for: {untitled}"
