"""The language of a text, English or German, from its grammar words: the
answer's check against the user's message (``assistant.agent.ends_with_text``),
the note's interface language (``assistant.prompt.render_note``) and the
evals' language check (``evals.graders``) read it.

A word list, not a language model: the names of places, layers and datasets
(German in English answers too) count for neither language, and a text that
shows no clear language gets no verdict."""

import re

from assistant.surfaces import Locale

#: Grammar words, question words and the verbs a request starts with that
#: only one of the two languages uses; a word spelled alike in both (in, also,
#: was, will, these) is in neither.
GRAMMAR_WORDS: dict[Locale, frozenset[str]] = {
    "en": frozenset(
        "the and is are of with this that which there has have for not can its "
        "what how many where who why does do you your my me it be were from by at "
        "on to into all show please when about any i we our find need want get "
        "give tell near around".split()
    ),
    "de": frozenset(
        "der die das und ist sind mit dieser diese hat haben für nicht kann keine "
        "ein eine wie viele welche welcher welchem welchen welches wo gibt es ich "
        "sie mir mich den dem des auf von zu im bei nach oder auch wird werden "
        "noch nur zeig zeige bitte wann warum wer kannst können finde suche gib "
        "liegt über alle einen einem einer wir uns zum zur vom".split()
    ),
}
#: A message with fewer words may not show its language (a name, a number).
LANGUAGE_FALLBACK_WORDS = 3
#: The grammar words (``clear_language``) a user message needs at the least
#: for its language to count.
MESSAGE_LANGUAGE_WORDS = 2

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

#: Letters only German uses: a word with them may be German, or a name.
_GERMAN_LETTERS = re.compile(r"[äöüß]", re.IGNORECASE)


def names_a_language(text: str) -> bool:
    return _NAMES_A_LANGUAGE.search(text) is not None


def may_be_german(text: str) -> bool:
    """Whether a text holds letters only German uses (ä, ö, ü, ß): its nouns
    may be German words, or names in a text of either language."""
    return _GERMAN_LETTERS.search(text) is not None


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


def shows_no_language(message: str) -> bool:
    """Whether a user message shows no language, so that the interface
    language answers it: under ``LANGUAGE_FALLBACK_WORDS`` words, or names,
    nouns and numbers without one grammar word of either language. A message
    with a few grammar words of one language shows that one, though not
    always clearly."""
    if len(message.split()) < LANGUAGE_FALLBACK_WORDS:
        return True
    return not any(_counts(_prose(message)).values())
