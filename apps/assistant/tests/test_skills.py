"""Built-in skills (spec §6.1): the loader refuses a malformed skill naming its
file, the index lists each skill once, and skills_load serves only what was
read at startup."""

import re
from pathlib import Path

import pytest
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

from assistant.history import KEPT_TOOLS, shorten_earlier_results
from assistant.skills import (
    BUILT_IN,
    INDEX_INTRO,
    SKILLS_DIR,
    SkillError,
    load_skills,
    skills_index,
)
from assistant.tools.runtime import InputInvalid
from assistant.tools.skills import SKILLS_LOAD, SkillsLoadInput, load_from
from assistant.tools.testing import fake_clients, tool_env

GOOD = """---
name: count-things
description: "When someone wants things counted: count them."
license: proprietary
---

# Count things

1. Count.
"""


def _skill(root: Path, folder: str, text: str, **files: str) -> Path:
    path = root / folder
    path.mkdir(parents=True)
    (path / "SKILL.md").write_text(text, encoding="utf-8")
    for name, content in files.items():
        (path / name).write_text(content, encoding="utf-8")
    return path


def test_a_skill_folder_loads_with_its_reference_files(tmp_path: Path) -> None:
    _skill(tmp_path, "count-things", GOOD, **{"recipes.md": "# Recipes\n"})
    skills = load_skills(tmp_path)
    assert list(skills) == ["count-things"]
    skill = skills["count-things"]
    assert skill.description == "When someone wants things counted: count them."
    assert skill.instructions == "# Count things\n\n1. Count."
    assert dict(skill.files) == {"recipes.md": "# Recipes\n"}


def test_the_index_lists_each_skill_by_name_and_description(tmp_path: Path) -> None:
    _skill(tmp_path, "count-things", GOOD)
    _skill(
        tmp_path,
        "draw-maps",
        "---\nname: draw-maps\ndescription: When a map is wanted.\n---\nDraw.\n",
    )
    assert skills_index(load_skills(tmp_path)) == "\n".join(
        [
            INDEX_INTRO,
            "- `count-things`: When someone wants things counted: count them.",
            "- `draw-maps`: When a map is wanted.",
        ]
    )


def test_no_skills_give_no_index(tmp_path: Path) -> None:
    assert skills_index(load_skills(tmp_path)) == ""


@pytest.mark.parametrize(
    ("text", "files", "message"),
    [
        ("# no front matter\n", {}, "starts with front matter"),
        ("---\nname: count-things\ndescription: d\n", {}, "not closed"),
        (
            "---\nname: count-things\ndescription: d\nauthor: x\n---\nA\n",
            {},
            "unknown front matter key 'author'",
        ),
        (
            "---\nname: count-things\nname: count-things\ndescription: d\n---\nA\n",
            {},
            "given twice",
        ),
        ("---\nname: Count_Things\ndescription: d\n---\nA\n", {}, "kebab case"),
        ("---\nname: other-name\ndescription: d\n---\nA\n", {}, "is not its folder's"),
        ("---\nname: count-things\ndescription:\n---\nA\n", {}, "description must be"),
        (
            "---\nname: count-things\ndescription: " + "x" * 1025 + "\n---\nA\n",
            {},
            "description must be",
        ),
        ("---\nname: count-things\ndescription: d\n---\n\n", {}, "no instructions"),
        ("---\nname: count-things\n  description: d\n---\nA\n", {}, "'key: value'"),
        (GOOD, {"script.py": "print(1)"}, "reference files are Markdown"),
    ],
)
def test_a_malformed_skill_is_refused_naming_its_file(
    tmp_path: Path, text: str, files: dict[str, str], message: str
) -> None:
    folder = _skill(tmp_path, "count-things", text, **files)
    with pytest.raises(SkillError) as caught:
        load_skills(tmp_path)
    assert message in str(caught.value)
    assert str(folder) in str(caught.value)


def test_a_folder_without_skill_md_or_with_a_subfolder_is_refused(
    tmp_path: Path,
) -> None:
    (tmp_path / "empty-skill").mkdir()
    with pytest.raises(SkillError, match="holds a SKILL.md"):
        load_skills(tmp_path)
    nested = tmp_path / "other"
    nested.mkdir()
    folder = _skill(nested, "count-things", GOOD)
    (folder / "more").mkdir()
    with pytest.raises(SkillError, match="sit next to SKILL.md"):
        load_skills(nested)


def test_folders_starting_with_an_underscore_or_a_dot_are_not_skills(
    tmp_path: Path,
) -> None:
    (tmp_path / "__pycache__").mkdir()
    (tmp_path / ".hidden").mkdir()
    (tmp_path / "notes.txt").write_text("x")
    assert load_skills(tmp_path) == {}


def test_the_built_in_skills_load_from_the_package() -> None:
    assert SKILLS_DIR.name == "skills"
    assert load_skills(SKILLS_DIR) == BUILT_IN
    for name, skill in BUILT_IN.items():
        assert skill.name == name == (SKILLS_DIR / name).name


def test_a_built_in_skill_names_exactly_the_reference_files_it_has() -> None:
    """The model learns a reference file from the instructions only: each
    file is named there, and no file the skill lacks is."""
    for name, skill in BUILT_IN.items():
        named = set(re.findall(r"\b[\w-]+\.md\b", skill.instructions)) - {"SKILL.md"}
        assert named == set(skill.files), name


async def test_skills_load_returns_the_instructions_and_names_the_files(
    tmp_path: Path,
) -> None:
    _skill(tmp_path, "count-things", GOOD, **{"recipes.md": "# Recipes\n"})
    run = load_from(load_skills(tmp_path))
    loaded = await run(tool_env(fake_clients()), SkillsLoadInput(name="count-things"))
    assert loaded.model_dump(exclude_none=True) == {
        "name": "count-things",
        "text": "# Count things\n\n1. Count.",
        "files": ["recipes.md"],
    }


async def test_skills_load_returns_a_reference_file(tmp_path: Path) -> None:
    _skill(tmp_path, "count-things", GOOD, **{"recipes.md": "# Recipes\n"})
    run = load_from(load_skills(tmp_path))
    loaded = await run(
        tool_env(fake_clients()),
        SkillsLoadInput(name="count-things", file="recipes.md"),
    )
    assert (loaded.file, loaded.text, loaded.files) == (
        "recipes.md",
        "# Recipes\n",
        None,
    )


@pytest.mark.parametrize(
    "file", ["../SKILL.md", "SKILL.md", "/etc/passwd", "missing.md"]
)
async def test_skills_load_serves_only_the_files_read(
    tmp_path: Path, file: str
) -> None:
    _skill(tmp_path, "count-things", GOOD, **{"recipes.md": "# Recipes\n"})
    run = load_from(load_skills(tmp_path))
    with pytest.raises(InputInvalid) as caught:
        await run(
            tool_env(fake_clients()), SkillsLoadInput(name="count-things", file=file)
        )
    assert "Its files: recipes.md." in caught.value.message


async def test_an_unknown_skill_is_refused_with_the_list(tmp_path: Path) -> None:
    _skill(tmp_path, "count-things", GOOD)
    run = load_from(load_skills(tmp_path))
    with pytest.raises(InputInvalid) as caught:
        await run(tool_env(fake_clients()), SkillsLoadInput(name="draw-maps"))
    assert caught.value.message == (
        "There is no skill 'draw-maps'. Skills: count-things."
    )


def test_skills_load_is_on_every_page_and_reads_only() -> None:
    assert SKILLS_LOAD.wire_name == "skills_load"
    assert SKILLS_LOAD.risk == "read" and not SKILLS_LOAD.mcp
    assert not SKILLS_LOAD.returns_data


def test_a_loaded_skill_stays_whole_in_later_answers() -> None:
    long_text = "Follow these steps. " * 200
    messages = [
        ModelRequest(parts=[UserPromptPart(content="build a workflow")]),
        ModelResponse(
            parts=[
                ToolCallPart(
                    tool_name="skills_load",
                    args={"name": "count-things"},
                    tool_call_id="c1",
                )
            ]
        ),
        ModelRequest(
            parts=[
                ToolReturnPart(
                    tool_name="skills_load",
                    content={"name": "count-things", "text": long_text},
                    tool_call_id="c1",
                )
            ]
        ),
        ModelResponse(parts=[TextPart(content="done")]),
        ModelRequest(parts=[UserPromptPart(content="and now?")]),
    ]
    assert "skills_load" in KEPT_TOOLS
    kept = shorten_earlier_results(messages)[2].parts[0]
    assert isinstance(kept, ToolReturnPart)
    assert kept.content == {"name": "count-things", "text": long_text}
