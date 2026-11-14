"""The language of a text, English or German, from its grammar words: the
answer's check against the user's message (``assistant.agent.ends_with_text``)
and the evals' language check (``evals.graders``) read it.

A word list, not a language model: the names of places, layers and datasets
(German in English answers too) count for neither language, and a text that
shows no clear language gets no verdict."""

import re

from assistant.surfaces import Locale

#: Grammar words and question words that only one of the two languages uses.
GRAMMAR_WORDS: dict[Locale, frozenset[str]] = {
    "en": frozenset(
        "the and is are of with this that which there has have for not can its "
        "what how many where who why does do you your my me it be were from by at "
        "on to into all show please".split()
    ),
    "de": frozenset(
        "der die das und ist sind mit dieser diese hat haben für nicht kann keine "
        "ein eine wie viele welche welcher welchem welchen welches wo gibt es ich "
        "sie mir mich den dem des auf von zu im bei nach oder auch wird werden "
        "noch nur zeig zeige bitte".split()
    ),
}

#: What the language of a text is not read from: code, bold or italic text
#: (names and titles), link texts, quotes and table rows (and titles in a
#: list, ``_LIST_ITEM``).
_NOT_PROSE = re.compile(
    r"```.*?```"
    r"|`[^`\n]*`"
    r"|\*\*[^*\n]+\*\*|__[^_\n]+__|(?<!\w)[*_][^*_\n]+[*_](?!\w)"
    r"|\[[^\]\n]*\]\([^)\n]*\)"
    r'|"[^"\n]*"|„[^“\n]*“|“[^”\n]*”'
    r"|^\s*\|.*$",
    re.S | re.M,
)


#: A list item: only what follows a title and its colon is prose. A bare
#: title in a list ("- Zählstellen für den Radverkehr") says nothing about
#: the language of the answer around it.
_LIST_ITEM = re.compile(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(.*)$", re.M)

#: A message that names a language or asks to translate: the answer's
#: language may then be the one it asks for.
_NAMES_A_LANGUAGE = re.compile(
    r"\b(?:english|englisch\w*|german|deutsch\w*|translat\w*|übersetz\w*)\b",
    re.IGNORECASE,
)


def names_a_language(text: str) -> bool:
    return _NAMES_A_LANGUAGE.search(text) is not None


def _prose(text: str) -> str:
    text = _NOT_PROSE.sub(" ", text)
    return _LIST_ITEM.sub(lambda item: item.group(1).partition(": ")[2], text)


def _counts(text: str) -> dict[Locale, int]:
    words = re.findall(r"[^\W\d_]+", text.casefold())
    return {
        language: sum(word in grammar for word in words)
        for language, grammar in GRAMMAR_WORDS.items()
    }


def answer_language(text: str) -> Locale | None:
    """English or German, by the grammar words; None when neither leads."""
    counts = _counts(text)
    if counts["en"] == counts["de"]:
        return None
    return "en" if counts["en"] > counts["de"] else "de"


def clear_language(text: str, minimum: int) -> Locale | None:
    """English or German when the text's prose shows it beyond doubt: at
    least ``minimum`` grammar words of one language and at most a fifth as
    many of the other. None otherwise: a text of names, numbers, code or
    titles, or one with words of both."""
    counts = _counts(_prose(text))
    lead: Locale = "en" if counts["en"] >= counts["de"] else "de"
    other: Locale = "de" if lead == "en" else "en"
    if counts[lead] < minimum or counts[other] * 5 > counts[lead]:
        return None
    return lead
