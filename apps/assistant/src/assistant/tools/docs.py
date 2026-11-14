"""``docs_read``: a page of GOAT's user documentation (``assistant.user_docs``),
for questions about GOAT's own interface. The core pack: offered on every page.

The page comes in the user's interface language when it has a German page,
since its labels are then the ones the user sees, and in English otherwise. A
page id is looked up among the pages read at startup, never opened as a path.
The docs are public and hold no organization data, so the data policy does
not apply; the tool is not on ``/mcp``, whose clients can read the docs site
itself (its ``llms.txt``).

An earlier answer's page goes to the model as its id and title only
(``assistant.history``): a page is long, and a later question reads it again.
"""

import difflib
import re
from collections.abc import Awaitable, Callable, Mapping

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai.exceptions import ToolFailed

from assistant.surfaces import SURFACES, Locale
from assistant.tools.runtime import InputInvalid, ToolEnv, ToolSpec
from assistant.user_docs import USER_DOCS, DocPage

#: Pages one answer may read: a how-to question needs one, rarely two, and
#: each page is resent with every later call of the answer.
MAX_PAGES_PER_ANSWER = 2
#: Reads one answer may make, a part of a long page counting as one: two
#: pages read in two parts each. A part of a page read already is no new page.
MAX_PARTS_PER_ANSWER = 4
#: A longer page comes in parts, each cut where a section starts, the rest
#: named by its headings (``left_out``) and read with ``section``.
MAX_PAGE_CHARS = 16_000
#: The headings a cut part names; the rest come with the next part.
MAX_LEFT_OUT = 30
TOO_MANY_PAGES = (
    "This answer has read two docs pages already ({pages}). Answer from them, "
    "and say plainly what they do not cover."
)
TOO_MANY_PARTS = (
    "This answer has read four parts of the docs already. Answer from them, and "
    "say plainly what they do not cover."
)
CUT_NOTE = (
    "The page goes on with the sections in left_out. If the answer is in them, "
    "read on with section set to one of them, the first to read on in order."
)

#: A cut inside the last section: what follows has no heading to read on from.
CUT_WITHOUT_SECTIONS = "The page goes on; the rest of this section is left out."

_FENCE = re.compile(r"^[ \t]*(```|~~~)")
_HEADING = re.compile(r"^#{1,6} (.+)$")


class DocsReadInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page: str = Field(
        min_length=1,
        max_length=120,
        description=(
            "The page's id from the docs list in your instructions: its folder and "
            "name, e.g. map/filter."
        ),
    )
    section: str | None = Field(
        default=None,
        min_length=1,
        max_length=200,
        description=(
            "A heading of the page, as a cut page's left_out names it: the page "
            "from that section on. Leave it out for the start of the page."
        ),
    )


class LoadedDoc(BaseModel):
    page: str
    #: The language of the text: the interface language, or English when
    #: the page has no German version.
    language: Locale
    title: str
    #: The heading the text starts at, when one was asked for.
    section: str | None = None
    text: str
    truncated: bool | None = None
    #: With ``truncated``: the headings of what this part leaves out.
    left_out: list[str] | None = None
    note: str | None = None


def _headings(text: str) -> list[tuple[int, str]]:
    """The page's headings outside code, with where each starts."""
    found: list[tuple[int, str]] = []
    fence = ""
    offset = 0
    for line in text.splitlines(keepends=True):
        match = _FENCE.match(line)
        if match and (not fence or match.group(1) == fence):
            fence = "" if fence else match.group(1)
        elif not fence and (heading := _HEADING.match(line)):
            found.append((offset, heading.group(1).strip()))
        offset += len(line)
    return found


def _key(heading: str) -> str:
    return " ".join(heading.strip().lstrip("#").split()).casefold()


def _part(text: str) -> tuple[str, list[str] | None]:
    """The first part of ``text`` that fits, cut where a section starts (at a
    paragraph when no section starts in time), and the headings after it;
    None for a text that fits whole."""
    if len(text) <= MAX_PAGE_CHARS:
        return text, None
    headings = _headings(text)
    starts = [offset for offset, _ in headings if 0 < offset <= MAX_PAGE_CHARS]
    end = starts[-1] if starts else text.rfind("\n\n", 0, MAX_PAGE_CHARS)
    if end <= 0:
        end = MAX_PAGE_CHARS
    return text[:end], [heading for offset, heading in headings if offset >= end]


def read_from(
    docs: Mapping[Locale, Mapping[str, DocPage]],
) -> Callable[[ToolEnv, DocsReadInput], Awaitable[LoadedDoc]]:
    english = docs["en"]

    async def run(env: ToolEnv, args: DocsReadInput) -> LoadedDoc:
        page_id = args.page.strip().strip("/").removesuffix(".md")
        if page_id not in english:
            close = difflib.get_close_matches(page_id, english, n=5, cutoff=0.6)
            hint = (
                f" Pages with a similar id: {', '.join(close)}."
                if close
                else " Take the id from the docs list in your instructions."
            )
            raise InputInvalid(f"There is no page {args.page!r} in GOAT's docs.{hint}")
        page = docs.get(env.locale, {}).get(page_id)
        language: Locale = env.locale
        if page is None:
            page, language = english[page_id], "en"
        text = page.text
        if args.section is not None:
            headings = _headings(text)
            start = next(
                (o for o, h in headings if _key(h) == _key(args.section)), None
            )
            if start is None:
                listed = ", ".join(h for _, h in headings) or "none"
                raise InputInvalid(
                    f"The page {page_id!r} has no section {args.section!r}. "
                    f"Its sections: {listed}."
                )
            text = text[start:]
        part = (page_id, _key(args.section or ""))
        if part not in env.docs_read:
            pages = list(dict.fromkeys(read for read, _ in env.docs_read))
            if page_id not in pages and len(pages) >= MAX_PAGES_PER_ANSWER:
                raise ToolFailed(TOO_MANY_PAGES.format(pages=", ".join(pages)))
            if len(env.docs_read) >= MAX_PARTS_PER_ANSWER:
                raise ToolFailed(TOO_MANY_PARTS)
            env.docs_read.append(part)
        shown, left_out = _part(text)
        return LoadedDoc(
            page=page_id,
            language=language,
            title=page.title,
            section=args.section.strip() if args.section is not None else None,
            text=shown,
            truncated=True if left_out is not None else None,
            left_out=left_out[:MAX_LEFT_OUT] if left_out else None,
            note=(CUT_NOTE if left_out else CUT_WITHOUT_SECTIONS)
            if left_out is not None
            else None,
        )

    return run


DOCS_READ: ToolSpec[DocsReadInput, LoadedDoc] = ToolSpec(
    name="docs.read",
    description=(
        "Read a page of GOAT's user documentation from the docs list in your "
        "instructions: how GOAT's interface works, its buttons, menus, dialogs and "
        "features, in the user's interface language. At most two pages per answer; "
        "a long page comes in parts."
    ),
    input_model=DocsReadInput,
    output_model=LoadedDoc,
    run=read_from(USER_DOCS),
    surfaces=frozenset(SURFACES),
    returns_data=False,
)
