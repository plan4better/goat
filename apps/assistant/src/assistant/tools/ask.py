"""``ask_user`` (spec §5.1): a card of questions in the dock, on every page.

The card reaches the dock as a ``data-ask`` part whose id is the card id:
``ask-`` and an id the tool mints for the card, never the provider's tool call
id, which some providers number per response and so repeat in a later answer.
After it, the run offers no more tools (``RunDeps.asked``), so the model ends
its answer; the user's choices come with their next message. One card per
answer: a second ``ask_user`` call in the same response runs after the first
(``ToolSpec.once_per_answer`` makes the tool sequential) and is refused with
``ONE_CARD`` without showing anything (``assistant.tools.toolset``). A card
after a finished workflow run's result, with no text written since, is
refused with ``REPORT_FIRST`` the same way (``ToolSpec.report_first``), in
at most two responses per result. Not on MCP: its clients cannot show it.
"""

import asyncio
from typing import Literal
from urllib.parse import quote
from uuid import UUID, uuid4

from pydantic import BaseModel
from pydantic_ai.exceptions import ToolFailed

from assistant.asks import CARD_PREFIX, AskUserInput, card_data
from assistant.surfaces import SURFACES
from assistant.tools.http import ServiceError, sign_in_expired
from assistant.tools.runtime import InputInvalid, ToolEnv, ToolSpec

ASKED_NOTE = (
    "The card is shown to the user. End your answer now, without asking the same "
    "in text; their choices come with their next message."
)
#: The failure of a second card in the same answer.
ONE_CARD = (
    "One card per answer: this card was not shown. Put every question into one "
    "card (up to four)."
)
#: The failure of a card while a finished workflow run's result is not yet in
#: the answer's text (``ToolSpec.report_first``, ``assistant.tools.toolset``),
#: also after a read of a run that checks how a layer was made. A model that
#: knows a response with text alone ends its answer otherwise keeps the card
#: and sends it again without text.
REPORT_FIRST = (
    "This card was not shown. In the same response, write the text first (what "
    "the result tells you: a run's numbers, what failed, or what it says about a "
    "layer you consider), then call ask_user. A response with text alone ends "
    "the answer without the card."
)
#: In place of ``REPORT_FIRST`` for a card sent again with the same arguments
#: as the card refused before it.
REPEATED_CARD = (
    "The card was refused because this response has no text: write the text in "
    "this response, then the card."
)


#: Distinct ids a card's ``adds`` may name: each is looked up before the card
#: is shown, so a card with more is refused unchecked.
MAX_CHECKED_ADDS = 50
#: Unknown ids of a card's ``adds`` its refusal names at most.
_NAMED_ADDS = 5


class AskShown(BaseModel):
    card_id: str
    status: Literal["asked"] = "asked"
    note: str = ASKED_NOTE


async def in_catalog(env: ToolEnv, item: str) -> bool | None:
    """Whether the catalog has a dataset or a bundle under ``item``; None
    when it cannot tell (it failed, or did not answer)."""
    try:
        await env.call("catalog", "GET", f"/stac/resolve/{quote(item, safe='')}")
    except ServiceError as exc:
        return False if exc.status == 404 else None
    except ToolFailed:
        return None
    return True


async def core_reads(env: ToolEnv, path: str) -> bool | None:
    """Whether core lets the user read ``path``; None when it cannot tell (it
    failed, or the sign-in expired)."""
    try:
        await env.call("core", "GET", path)
    except ServiceError as exc:
        if sign_in_expired(exc) or exc.status not in (401, 403, 404, 422):
            return None
        return False
    except ToolFailed:
        return None
    return True


async def users_dataset(env: ToolEnv, item: str) -> bool:
    """Whether ``item`` is a dataset the user can read in core; only a UUID
    can be one. An id core cannot tell about, or one it will not let the
    user read, is none."""
    try:
        dataset_id = UUID(item)
    except ValueError:
        return False
    return await core_reads(env, f"/api/v2/layer/{dataset_id}") is True


async def _readable(env: ToolEnv, item: str) -> bool | None:
    """Whether ``item`` is a dataset of the user's that they can read, as
    ``project_add_dataset`` checks it, or a bundle of theirs, whose layers a
    pick of it lets the add tool add (bundles have a table of their own);
    None when core cannot tell."""
    try:
        dataset_id = UUID(item)
    except ValueError:
        return False
    layer = await core_reads(env, f"/api/v2/layer/{dataset_id}")
    if layer is not False:
        return layer
    return await core_reads(env, f"/api/v2/bundle/{dataset_id}/layers")


async def _unknown(env: ToolEnv, item: str) -> bool:
    """Whether neither the catalog nor core knows ``item``. A lookup that
    cannot tell lets it pass: the add tools check it again."""
    found = await asyncio.gather(in_catalog(env, item), _readable(env, item))
    return all(known is False for known in found)


async def _check_adds(env: ToolEnv, card: AskUserInput) -> None:
    """Refuses a card whose options add ids no dataset has, each id looked up
    once, all at the same time, and one with more ids than
    ``MAX_CHECKED_ADDS`` without looking any up."""
    ids = list(
        dict.fromkeys(
            item
            for question in card.questions
            for option in question.options
            for item in option.adds
        )
    )
    if len(ids) > MAX_CHECKED_ADDS:
        raise InputInvalid(
            f"The card's options add {len(ids)} different datasets; a card adds "
            f"at most {MAX_CHECKED_ADDS}: put fewer ids in it."
        )
    unknown = [
        item
        for item, missing in zip(
            ids,
            await asyncio.gather(*(_unknown(env, item) for item in ids)),
            strict=True,
        )
        if missing
    ]
    if not unknown:
        return
    named = ", ".join(repr(item) for item in unknown[:_NAMED_ADDS])
    if len(unknown) > _NAMED_ADDS:
        named += f" and {len(unknown) - _NAMED_ADDS} more"
    if len(unknown) == 1:
        raise InputInvalid(
            f"adds names {named}, which is no catalog dataset and no dataset you "
            "can read: take the id from catalog_search or core_find."
        )
    raise InputInvalid(
        f"adds names {named}, which are no catalog datasets and no datasets you "
        "can read: take the ids from catalog_search or core_find."
    )


async def _ask(env: ToolEnv, args: AskUserInput) -> AskShown:
    if env.emit_data is None:
        raise ToolFailed(
            "Questions with a card can only be asked in the GOAT assistant."
        )
    await _check_adds(env, args)
    card_id = CARD_PREFIX + uuid4().hex
    await env.emit_data("ask", card_data(card_id, args), part_id=card_id)
    return AskShown(card_id=card_id)


ASK_USER: ToolSpec[AskUserInput, AskShown] = ToolSpec(
    name="ask.user",
    description=(
        "Ask the user with a card when they have to choose: which dataset fits, "
        "which variant they mean. Up to four questions in one card, answered "
        "together; each has two to four options with a short label, a one-line "
        "description and optionally a value (an id you need back, never shown). "
        "An option that adds datasets lists their ids in adds (never shown); "
        "its value may then be any short key. The card adds a free-text field "
        "itself. After it, end your answer."
    ),
    input_model=AskUserInput,
    output_model=AskShown,
    run=_ask,
    surfaces=frozenset(SURFACES),
    returns_data=False,
    once_per_answer=ONE_CARD,
)
