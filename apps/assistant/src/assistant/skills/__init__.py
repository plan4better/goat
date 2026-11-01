"""Built-in skills (spec §6.1): instructions the assistant loads when a request
fits one, in the Agent Skills format.

Each skill is a folder next to this module, named like the skill, holding a
``SKILL.md`` (front matter with ``name`` and ``description``, then the
instructions) and the Markdown reference files its instructions point to.
Nothing in a skill is ever executed: it is text for the model.

Every file is read once, when this module is imported, so a malformed skill
stops the service at startup with the file named in the error, and
``skills_load`` serves only what was read: a requested file name is looked up
among those files, never opened as a path.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

SKILLS_DIR = Path(__file__).resolve().parent
SKILL_FILE = "SKILL.md"
NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MAX_NAME_CHARS = 64
MAX_DESCRIPTION_CHARS = 1024
#: The front matter keys read. Another key is refused, so a misspelled one
#: does not pass unnoticed.
FRONT_MATTER_KEYS = frozenset({"name", "description", "license"})
INDEX_INTRO = (
    "Skills: load one with skills_load(name) when the user's request fits its "
    "description, and follow it."
)


class SkillError(ValueError):
    """A built-in skill that does not follow the format; the message names the file."""


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    instructions: str
    #: The reference files next to SKILL.md, by file name.
    files: Mapping[str, str] = field(default_factory=dict)


def _unquoted(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _front_matter(path: Path) -> tuple[dict[str, str], str]:
    """The front matter's ``key: value`` lines and the text after it."""
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        raise SkillError(f"{path}: starts with front matter between '---' lines")
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        raise SkillError(f"{path}: the front matter is not closed with '---'")
    meta: dict[str, str] = {}
    for number, line in enumerate(lines[1:end], start=2):
        if not line.strip():
            continue
        key, colon, value = line.partition(":")
        key = key.strip()
        if not colon or not key or line[:1].isspace():
            raise SkillError(f"{path}:{number}: front matter lines are 'key: value'")
        if key not in FRONT_MATTER_KEYS:
            raise SkillError(f"{path}:{number}: unknown front matter key {key!r}")
        if key in meta:
            raise SkillError(f"{path}:{number}: {key!r} is given twice")
        meta[key] = _unquoted(value)
    return meta, "\n".join(lines[end + 1 :]).strip()


def load_skill(folder: Path) -> Skill:
    path = folder / SKILL_FILE
    if not path.is_file():
        raise SkillError(f"{folder}: a skill folder holds a {SKILL_FILE}")
    meta, instructions = _front_matter(path)
    name = meta.get("name", "")
    description = meta.get("description", "")
    if not NAME_PATTERN.fullmatch(name) or len(name) > MAX_NAME_CHARS:
        raise SkillError(
            f"{path}: name must be kebab case, at most {MAX_NAME_CHARS} characters"
        )
    if name != folder.name:
        raise SkillError(f"{path}: name {name!r} is not its folder's {folder.name!r}")
    if not description or len(description) > MAX_DESCRIPTION_CHARS:
        raise SkillError(
            f"{path}: description must be 1 to {MAX_DESCRIPTION_CHARS} characters"
        )
    if not instructions:
        raise SkillError(f"{path}: no instructions after the front matter")
    files: dict[str, str] = {}
    for item in sorted(folder.iterdir()):
        if item.name == SKILL_FILE:
            continue
        if item.is_dir():
            raise SkillError(f"{item}: reference files sit next to {SKILL_FILE}")
        if item.suffix != ".md":
            raise SkillError(f"{item}: reference files are Markdown (.md)")
        files[item.name] = item.read_text(encoding="utf-8")
    return Skill(name, description, instructions, files)


def load_skills(root: Path) -> dict[str, Skill]:
    """Every skill folder under ``root``, by name. Folders starting with ``_``
    or ``.`` (``__pycache__``) are not skills."""
    skills: dict[str, Skill] = {}
    for folder in sorted(root.iterdir()):
        if folder.is_dir() and not folder.name.startswith(("_", ".")):
            skill = load_skill(folder)
            skills[skill.name] = skill
    return skills


def skills_index(skills: Mapping[str, Skill]) -> str:
    """The skills list of the instructions: one ``name``: description line
    each; empty without skills, so nothing is sent."""
    if not skills:
        return ""
    lines = [INDEX_INTRO]
    lines += [f"- `{skill.name}`: {skill.description}" for skill in skills.values()]
    return "\n".join(lines)


BUILT_IN: dict[str, Skill] = load_skills(SKILLS_DIR)
