"""A translator reads only the translation file of a supported language.

The language comes from the request (Accept-Language): any other value reads
the default language's file, never a path built from it.
"""

import json
from pathlib import Path

import goatlib.i18n as i18n
import pytest


@pytest.fixture
def translations(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    folder = tmp_path / "translations"
    folder.mkdir()
    for language in ("en", "de"):
        (folder / f"{language}.json").write_text(
            json.dumps({"fields": {"name": {"label": language}}})
        )
    (tmp_path / "elsewhere.json").write_text(
        json.dumps({"fields": {"name": {"label": "elsewhere"}}})
    )
    monkeypatch.setattr(i18n, "TRANSLATIONS_DIR", folder)
    return folder


def test_a_supported_language_reads_its_file(translations: Path) -> None:
    assert i18n.Translator("de").get_field_label("name") == "de"


@pytest.mark.parametrize("language", ["fr", "../elsewhere", "/etc/elsewhere"])
def test_any_other_language_reads_the_default_file(
    translations: Path, language: str
) -> None:
    translator = i18n.Translator(language)

    assert translator.get_field_label("name") == "en"
    assert translator.language == "en"
