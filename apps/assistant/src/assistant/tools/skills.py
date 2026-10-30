"""``skills_load`` (spec §6.1): a built-in skill's instructions, or one of its
reference files. The core pack: offered on every page.

The result stays whole in the conversation's history (``history.KEPT_TOOLS``),
so a skill loaded once is still there in later answers.
"""

from collections.abc import Awaitable, Callable, Mapping

from pydantic import BaseModel, ConfigDict, Field

from assistant.skills import BUILT_IN, Skill
from assistant.surfaces import SURFACES
from assistant.tools.runtime import InputInvalid, ToolEnv, ToolSpec


class SkillsLoadInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(
        min_length=1,
        max_length=64,
        description="The skill's name, as the skills list in your instructions gives it.",
    )
    file: str | None = Field(
        default=None,
        min_length=1,
        max_length=100,
        description=(
            "A reference file the skill's instructions name, e.g. heatmap.md; "
            "leave it out for the instructions."
        ),
    )


class LoadedSkill(BaseModel):
    name: str
    #: The reference file returned; None for the instructions.
    file: str | None = None
    text: str
    #: With the instructions: the reference files the skill has.
    files: list[str] | None = None


def load_from(
    skills: Mapping[str, Skill],
) -> Callable[[ToolEnv, SkillsLoadInput], Awaitable[LoadedSkill]]:
    async def run(env: ToolEnv, args: SkillsLoadInput) -> LoadedSkill:
        skill = skills.get(args.name)
        if skill is None:
            listed = ", ".join(sorted(skills)) or "none"
            raise InputInvalid(f"There is no skill {args.name!r}. Skills: {listed}.")
        if args.file is None:
            return LoadedSkill(
                name=skill.name,
                text=skill.instructions,
                files=sorted(skill.files) or None,
            )
        text = skill.files.get(args.file)
        if text is None:
            listed = ", ".join(sorted(skill.files)) or "none"
            raise InputInvalid(
                f"The skill {skill.name!r} has no file {args.file!r}. Its files: {listed}."
            )
        return LoadedSkill(name=skill.name, file=args.file, text=text)

    return run


SKILLS_LOAD: ToolSpec[SkillsLoadInput, LoadedSkill] = ToolSpec(
    name="skills.load",
    description=(
        "Load a skill from the skills list in your instructions: its instructions, "
        "or one of its reference files (file). A skill loaded earlier in this "
        "conversation is still in it; do not load it again."
    ),
    input_model=SkillsLoadInput,
    output_model=LoadedSkill,
    run=load_from(BUILT_IN),
    surfaces=frozenset(SURFACES),
    returns_data=False,
)
