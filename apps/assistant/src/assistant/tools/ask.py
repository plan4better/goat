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
at most two responses per result. A card that asks again under the header of
a question the user answered in an earlier card, or offers again what they
picked under the same question, is refused with that answer named
(``assistant.asks.repeated_question``), and so is one whose option names a
catalog dataset the answer found but adds nothing
(``assistant.asks.unadded_dataset``). The ids an option adds are looked up
before the card is shown, and the result names each option's datasets by
the titles found, so an id that is not the data its label names shows
before the user picks. A card adding an id no dataset has is refused with
the catalog datasets the answer found, by their exact ids, so the model
corrects a shortened or invented id in one call. Not on MCP: its clients
cannot show it.
"""

import asyncio
from collections.abc import Mapping, Sequence
from difflib import SequenceMatcher
from typing import Any, Literal
from urllib.parse import quote
from uuid import UUID, uuid4

from pydantic import BaseModel
from pydantic_ai.exceptions import ToolFailed

from assistant.asks import (
    CARD_PREFIX,
    AskUserInput,
    card_data,
    repeated_question,
    unadded_dataset,
)
from assistant.surfaces import SURFACES
from assistant.tools.http import ServiceError, sign_in_expired
from assistant.tools.runtime import InputInvalid, ToolEnv, ToolSpec

ASKED_NOTE = (
    "The card is shown to the user. End your answer now, without asking the same "
    "in text; their choices come with their next message."
)
#: Follows ASKED_NOTE when options add datasets (``AskShown.adds``): the ids
#: are checked to exist, not to be the data the label names.
ADDS_NAMED = (
    "adds lists the datasets each option adds, by title: if one is not the "
    "data its label names, tell the user in your text."
)
#: In ``AskShown.adds`` for a dataset whose lookup gave no title.
UNKNOWN_TITLE = "(no title found)"
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
#: The catalog datasets the answer found that such a refusal names at most.
MAX_NAMED_FOUND = 10
#: The characters of each of their titles it keeps: the id is what the model
#: copies, and catalog titles can run to a sentence each.
FOUND_TITLE_CHARS = 80


class OptionAdds(BaseModel):
    #: The option's label.
    option: str
    #: The title of each dataset it adds, as the lookup that checked its id
    #: found it.
    datasets: list[str]


class AskShown(BaseModel):
    card_id: str
    status: Literal["asked"] = "asked"
    #: The options that add datasets, each with their titles.
    adds: list[OptionAdds] | None = None
    note: str = ASKED_NOTE


#: What a lookup of an id found: whether it names a dataset (None when the
#: service could not tell), and the dataset's title when it has one.
Found = tuple[bool | None, str | None]


def _title(value: Any) -> str | None:
    return (value.strip() or None) if isinstance(value, str) else None


def _catalog_title(resolved: Any) -> str | None:
    """The title of a dataset or a bundle as the catalog resolves it."""
    if not isinstance(resolved, dict):
        return None
    if resolved.get("kind") == "item":
        item = resolved.get("item")
        props = item.get("properties") if isinstance(item, dict) else None
        return _title(props.get("title")) if isinstance(props, dict) else None
    collection = resolved.get("collection")
    return _title(collection.get("title")) if isinstance(collection, dict) else None


async def _catalog_entry(env: ToolEnv, item: str) -> Found:
    """Whether the catalog has a dataset or a bundle under ``item``, and its
    title."""
    try:
        resolved = await env.call(
            "catalog", "GET", f"/stac/resolve/{quote(item, safe='')}"
        )
    except ServiceError as exc:
        return (False if exc.status == 404 else None), None
    except ToolFailed:
        return None, None
    return True, _catalog_title(resolved)


async def in_catalog(env: ToolEnv, item: str) -> bool | None:
    """Whether the catalog has a dataset or a bundle under ``item``; None
    when it cannot tell (it failed, or did not answer)."""
    return (await _catalog_entry(env, item))[0]


async def _core_entry(env: ToolEnv, path: str) -> tuple[bool | None, Any]:
    """Whether core lets the user read ``path``, and what it answered; None
    when it cannot tell (it failed, or the sign-in expired)."""
    try:
        body = await env.call("core", "GET", path)
    except ServiceError as exc:
        if sign_in_expired(exc) or exc.status not in (401, 403, 404, 422):
            return None, None
        return False, None
    except ToolFailed:
        return None, None
    return True, body


async def core_reads(env: ToolEnv, path: str) -> bool | None:
    """Whether core lets the user read ``path``; None when it cannot tell (it
    failed, or the sign-in expired)."""
    return (await _core_entry(env, path))[0]


async def users_dataset(env: ToolEnv, item: str) -> bool:
    """Whether ``item`` is a dataset the user can read in core; only a UUID
    can be one. An id core cannot tell about, or one it will not let the
    user read, is none."""
    try:
        dataset_id = UUID(item)
    except ValueError:
        return False
    return await core_reads(env, f"/api/v2/layer/{dataset_id}") is True


async def _readable(env: ToolEnv, item: str) -> Found:
    """Whether ``item`` is a dataset of the user's that they can read, as
    ``project_add_dataset`` checks it, or a bundle of theirs, whose layers a
    pick of it lets the add tool add (bundles have a table of their own);
    None when core cannot tell. A dataset's name is its title; core lists a
    bundle's layers without one."""
    try:
        dataset_id = UUID(item)
    except ValueError:
        return False, None
    layer, body = await _core_entry(env, f"/api/v2/layer/{dataset_id}")
    if layer is not False:
        return layer, _title(body.get("name")) if isinstance(body, dict) else None
    bundle, _ = await _core_entry(env, f"/api/v2/bundle/{dataset_id}/layers")
    return bundle, None


async def _lookup(env: ToolEnv, item: str) -> Found:
    """Whether ``item`` names a dataset: False when neither the catalog nor
    core knows it. A lookup that cannot tell lets it pass: the add tools
    check it again. With the title either of them gave."""
    (catalog, catalog_title), (own, own_title) = await asyncio.gather(
        _catalog_entry(env, item), _readable(env, item)
    )
    known = False if catalog is False and own is False else True
    return known, catalog_title or own_title


def _clip(title: str) -> str:
    if len(title) <= FOUND_TITLE_CHARS:
        return title
    return title[: FOUND_TITLE_CHARS - 1].rstrip() + "…"


def _found_datasets(found: Mapping[str, str], refused: Sequence[str]) -> str:
    """The catalog datasets the answer found (``found``: titles by id,
    ``ToolEnv.catalog_titles``) as the refusal of the ``refused`` ids names
    them, by their exact ids, so the model corrects the card in one call:
    the ids most like a refused one first, since a model that shortened or
    garbled an id finds the right one there, then in the order found; at
    most ``MAX_NAMED_FOUND``, each title cut at ``FOUND_TITLE_CHARS``. Empty
    when the answer found none."""
    if not found:
        return ""

    def closeness(item: str) -> float:
        return max(SequenceMatcher(None, item, given).ratio() for given in refused)

    # sorted is stable: ids alike in closeness stay in the order found.
    ranked = sorted(found, key=closeness, reverse=True)
    listed = ", ".join(
        f'"{_clip(found[item])}" (id {item})' for item in ranked[:MAX_NAMED_FOUND]
    )
    if len(ranked) > MAX_NAMED_FOUND:
        listed += f" and {len(ranked) - MAX_NAMED_FOUND} more"
    return f" The catalog datasets this answer found, the closest ids first: {listed}."


async def _check_adds(env: ToolEnv, card: AskUserInput) -> dict[str, str | None]:
    """Refuses a card whose options add ids no dataset has, each id looked up
    once, all at the same time, and one with more ids than
    ``MAX_CHECKED_ADDS`` without looking any up. The titles the lookups
    found, by id."""
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
    found = dict(
        zip(
            ids,
            await asyncio.gather(*(_lookup(env, item) for item in ids)),
            strict=True,
        )
    )
    unknown = [item for item, (known, _) in found.items() if known is False]
    if not unknown:
        return {item: title for item, (_, title) in found.items()}
    named = ", ".join(repr(item) for item in unknown[:_NAMED_ADDS])
    if len(unknown) > _NAMED_ADDS:
        named += f" and {len(unknown) - _NAMED_ADDS} more"
    listed = _found_datasets(env.catalog_titles, unknown[:_NAMED_ADDS])
    if len(unknown) == 1:
        raise InputInvalid(
            f"adds names {named}, which is no catalog dataset and no dataset you "
            f"can read: take the id from catalog_search or core_find.{listed}"
        )
    raise InputInvalid(
        f"adds names {named}, which are no catalog datasets and no datasets you "
        f"can read: take the ids from catalog_search or core_find.{listed}"
    )


def _named_adds(card: AskUserInput, titles: dict[str, str | None]) -> list[OptionAdds]:
    """The options that add datasets, each with the titles of what it adds."""
    return [
        OptionAdds(
            option=option.label,
            datasets=[titles.get(item) or UNKNOWN_TITLE for item in option.adds],
        )
        for question in card.questions
        for option in question.options
        if option.adds
    ]


async def _ask(env: ToolEnv, args: AskUserInput) -> AskShown:
    if env.emit_data is None:
        raise ToolFailed(
            "Questions with a card can only be asked in the GOAT assistant."
        )
    repeat = repeated_question(env.asks, args, env.runs.used_cards)
    if repeat is not None:
        raise InputInvalid(repeat)
    unadded = unadded_dataset(args, env.catalog_titles)
    if unadded is not None:
        raise InputInvalid(unadded)
    adds = _named_adds(args, await _check_adds(env, args))
    card_id = CARD_PREFIX + uuid4().hex
    await env.emit_data("ask", card_data(card_id, args), part_id=card_id)
    if not adds:
        return AskShown(card_id=card_id)
    return AskShown(card_id=card_id, adds=adds, note=f"{ASKED_NOTE} {ADDS_NAMED}")


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
