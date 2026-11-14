"""GOAT's user docs for the assistant: the cleaner turns a Docusaurus page into
plain text, the index lists every page once, and docs_read serves only what
was read at startup, in the interface language when the page has it."""

import asyncio
import re
from pathlib import Path
from uuid import UUID

import pytest
from pydantic_ai.exceptions import ToolFailed

from assistant.agent import build_agent
from assistant.bus import InMemoryEventBus
from assistant.config import AssistantSettings
from assistant.context import parse_context
from assistant.events import ToolFailed as ToolFailedEvent
from assistant.events import ToolReturned
from assistant.login import StaticLogin
from assistant.prompt import static_instructions
from assistant.repo import Repository
from assistant.runs.manager import RunManager
from assistant.tools.docs import (
    DOCS_READ,
    MAX_PAGE_CHARS,
    MAX_PAGES_PER_ANSWER,
    MAX_PARTS_PER_ANSWER,
    DocsReadInput,
    read_from,
)
from assistant.tools.registry import MCP_TOOLS
from assistant.tools.runtime import InputInvalid, execute
from assistant.tools.testing import ScriptedModel, fake_clients, tool_env
from assistant.user_docs import (
    DOCS_INDEX,
    INDEX_INTRO,
    USER_DOCS,
    DocPage,
    DocsError,
    checkout_roots,
    clean,
    docs_index,
    load_docs,
    load_tree,
    read_page,
)

CHECKOUT = checkout_roots()

STEPS = """\
## Create Layer

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click on <code>+ Add Layer</code> and select <code>Create Layer</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Enter a <b>Layer name</b> and click <strong>Next</strong>.</div>
</div>
"""


def test_steps_become_a_numbered_list_with_their_labels() -> None:
    assert clean(STEPS) == (
        "## Create Layer\n\n"
        "1. Click on `+ Add Layer` and select `Create Layer`.\n\n"
        "2. Enter a **Layer name** and click **Next**."
    )


def test_a_step_with_a_list_keeps_its_items() -> None:
    text = clean(
        '<div class="step">\n  <div class="step-number">3</div>\n'
        '  <div class="content">\n  Choose the input mode:\n    <ul>\n'
        "      <li><b>Single field</b>: one column</li>\n"
        "      <li><b>Several fields</b>: street and city</li>\n"
        "    </ul>\n  </div>\n</div>\n"
    )
    assert text == (
        "3. Choose the input mode:\n"
        "- **Single field**: one column\n"
        "- **Several fields**: street and city"
    )


def test_images_videos_and_frames_are_dropped() -> None:
    text = clean(
        "Click the <img src={require('/img/icons/3dots.png').default} alt=\"Options\" "
        'style={{ maxHeight: "20px", maxWidth: "20px"}}/> <code>more options</code> icon.\n\n'
        "<div style={{ display: 'flex', justifyContent: 'center' }}>\n"
        "<img src={require('/img/map/filter.webp').default} alt=\"Filter\" "
        'style={{ maxHeight: "450px", objectFit: "cover"}}/>\n'
        "</div>\n\n"
        "<Video src={require('/img/map/filter.mp4').default}\n"
        '  alt="Filter tool" style={{ maxWidth: "80%"}}/>\n\n'
        '<iframe width="560" src="https://www.youtube.com/embed/x" allowfullscreen></iframe>\n\n'
        "![Context Diagram](../../static/diagrams/context.svg)\n\n"
        "Done."
    )
    assert text == "Click the `more options` icon.\n\nDone."


def test_an_icon_before_punctuation_leaves_no_space() -> None:
    assert clean(
        "click the options icon <img src={require('/img/icons/3dots.png').default} "
        'alt="Options"/>. The panel opens.'
    ) == ("click the options icon. The panel opens.")


def test_heading_ids_are_dropped() -> None:
    assert clean("## Answers {#answers}\n\nText.") == "## Answers\n\nText."


def test_tables_stay_and_layout_divs_go() -> None:
    table = (
        "| Expressions for `number` | Expressions for `string` |\n"
        "| -------|----|\n"
        "| Is  | Is |\n"
        "| <button>abs(-5)</button> = 5 | Starts with |"
    )
    text = clean(
        "<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>\n\n"
        f"{table}\n\n</div>\n"
    )
    assert text == table.replace("<button>abs(-5)</button>", "`abs(-5)`")


def test_code_blocks_and_inline_code_are_kept_as_written() -> None:
    source = (
        "Download `goat-compose-<version>.tar.gz` and unpack it.\n\n"
        "```bash\n"
        'tar xzf goat-compose-<version>.tar.gz <div class="step">\n'
        "import x from 'y';\n"
        "```\n"
    )
    assert clean(source) == source.strip()


def test_imports_tabs_admonitions_entities_and_comments() -> None:
    text = clean(
        "import Tabs from '@theme/Tabs';\n"
        "import TabItem from '@theme/TabItem';\n\n"
        "<!-- TODO: add a video -->\n\n"
        "<Tabs>\n"
        '  <TabItem value="gaussian" label="Gaussian" default className="tabItemBox">\n\n'
        "Weights fall off like a bell curve.\n\n"
        "  </TabItem>\n"
        "</Tabs>\n\n"
        ":::tip tip\n\n"
        "Use <code>if(&quot;population&quot; &gt; 100000, 'large', 'small')</code>.\n\n"
        ":::\n\n"
        ":::warning\nThis cannot be undone.\n:::\n"
    )
    assert text == (
        "**Gaussian**\n\n"
        "Weights fall off like a bell curve.\n\n"
        "Tip:\n\n"
        "Use `if(\"population\" > 100000, 'large', 'small')`.\n\n"
        "Warning:\nThis cannot be undone."
    )


def test_links_keep_their_text() -> None:
    assert clean(
        'See <a href="../data/data_types">Field Types</a> and the '
        "[Content page](../workspace/content)."
    ) == ("See Field Types and the Content page.")


def test_a_formula_keeps_its_tex_and_components_go() -> None:
    text = clean(
        "import ImpedanceFunction from '@site/src/components/ImpedanceFunction';\n\n"
        "<MathJax.Provider>\n"
        "  <div style={{ marginTop: '20px', fontSize: '24px' }}>\n"
        '    <MathJax.Node formula={"R_j = \\\\frac{S_j}{\\\\sum_{k} D_k}"} />\n'
        "  </div>\n"
        "</MathJax.Provider>\n\n"
        "<ImpedanceFunction />\n\n"
        '<DocsHero title="Welcome">Guides for GOAT.</DocsHero>\n\n'
        "<DocsSectionCards />\n"
    )
    assert text == "R_j = \\frac{S_j}{\\sum_{k} D_k}\n\nGuides for GOAT."


def test_a_formula_in_a_template_literal_keeps_its_tex() -> None:
    text = clean(
        "<MathJax.Node formula={`\n"
        "      f(t) =\n"
        "      \\\\begin{cases} 1 & t \\\\leq \\\\bar{t} \\\\end{cases}\n"
        "    `} />\n"
    )
    assert text == "f(t) = \\begin{cases} 1 & t \\leq \\bar{t} \\end{cases}"


PAGE = """---
description: "Filter a layer: by attribute, or by map extent."
sidebar_position: 5
---
import Tabs from '@theme/Tabs';

# Filter

**Filter limits data visibility** on your map.
"""


def _write(root: Path, name: str, text: str) -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_a_page_is_read_with_its_title_and_description(tmp_path: Path) -> None:
    _write(tmp_path, "map/filter.md", PAGE)
    pages = load_tree(tmp_path)
    assert list(pages) == ["map/filter"]
    page = pages["map/filter"]
    assert page.title == "Filter"
    assert page.description == "Filter a layer: by attribute, or by map extent."
    assert page.text == "# Filter\n\n**Filter limits data visibility** on your map."


def test_a_title_in_the_front_matter_wins_and_heads_the_text(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "getting_started/welcome.md",
        '---\ntitle: Welcome to GOAT\ndescription: "What GOAT is."\nhide_title: true\n---\n\nHello.\n',
    )
    page = load_tree(tmp_path)["getting_started/welcome"]
    assert page.title == "Welcome to GOAT"
    assert page.text == "# Welcome to GOAT\n\nHello."


def test_a_page_without_a_description_has_none(tmp_path: Path) -> None:
    _write(tmp_path, "map/bare.md", "# Bare\n\nText.\n")
    assert load_tree(tmp_path)["map/bare"].description == ""


def test_unclosed_front_matter_is_refused_naming_the_file(tmp_path: Path) -> None:
    path = _write(tmp_path, "map/broken.md", "---\ndescription: x\n# Broken\n")
    with pytest.raises(DocsError, match=re.escape(str(path))):
        load_tree(tmp_path)


def test_a_hidden_category_is_left_out(tmp_path: Path) -> None:
    _write(tmp_path, "map/filter.md", PAGE)
    _write(tmp_path, "nerdy/_category_.json", '{"label": "X", "className": "hidden"}')
    _write(tmp_path, "nerdy/inside.md", "# Inside\n")
    assert list(load_tree(tmp_path)) == ["map/filter"]


def test_the_index_lists_each_page_once_by_folder() -> None:
    pages = {
        "map/filter": DocPage("map/filter", "Filter", "Filter a layer.", ""),
        "map/layers": DocPage("map/layers", "Layers", "Add layers.", ""),
        "sharing/public": DocPage("sharing/public", "Publish", "Publish a map.", ""),
    }
    assert docs_index(pages) == "\n".join(
        [
            INDEX_INTRO,
            "map/",
            "- filter: Filter a layer.",
            "- layers: Add layers.",
            "sharing/",
            "- public: Publish a map.",
        ]
    )


# The real pages, in both languages: every one must clean without leftovers.
REAL_PAGES = [
    (f"{language}:{path.relative_to(root).as_posix()}", path, root)
    for language, root in CHECKOUT.items()
    for path in sorted(root.rglob("*.md"))
]
LEFTOVERS = re.compile(
    r"require\(|style=\{\{|className=|class=\"|<div|</div|<img|<Video|<iframe|"
    r"<code>|<b>|<strong>|<button|<br|<p>|<li>|<ul>|<!--|^:::|"
    # A JSX component the cleaner does not know yet.
    r"<[A-Z][\w.]*[\s/>]",
    re.M,
)
FENCED = re.compile(r"^[ \t]*(```|~~~).*?^[ \t]*\1", re.M | re.S)
HEADING = re.compile(r"^#{1,6} ", re.M)


def _outside_code(text: str) -> str:
    """The text without fenced blocks and inline code, which stay as written."""
    return re.sub(r"`[^`\n]*`", "", FENCED.sub("", text))


def test_the_checkout_has_the_docs_in_both_languages() -> None:
    assert set(CHECKOUT) == {"en", "de"}
    assert len(REAL_PAGES) > 150


@pytest.mark.parametrize(
    ("path", "root"),
    [(path, root) for _, path, root in REAL_PAGES],
    ids=[name for name, _, _ in REAL_PAGES],
)
def test_every_real_page_cleans_without_leftover_markup(path: Path, root: Path) -> None:
    page = read_page(path, path.relative_to(root).with_suffix("").as_posix())
    assert page.text.strip() and page.title
    leftover = LEFTOVERS.search(_outside_code(page.text))
    assert leftover is None, f"{path}: {leftover.group(0)!r} left in the text"
    # Nothing is cut away with a tag that is never closed: every heading of
    # the source is still there.
    source = path.read_text(encoding="utf-8").split("\n---", 2)[-1]
    headings = len(HEADING.findall(_outside_code(source)))
    assert len(HEADING.findall(_outside_code(page.text))) >= headings, path


def test_every_indexed_page_has_a_description() -> None:
    missing = [
        str(CHECKOUT[language] / f"{page.id}.md")
        for language, pages in load_docs(CHECKOUT).items()
        for page in pages.values()
        if not page.description
    ]
    assert not missing, "Pages without a description in their front matter: " + (
        ", ".join(missing)
    )


def test_the_interface_pages_come_out_about_half_as_long() -> None:
    """The pages of the map and of sharing are mostly steps, screenshots and
    labels; prose-heavy pages (self-hosting, methods) shrink less."""
    raw = cleaned = 0
    for language, pages in USER_DOCS.items():
        for page in pages.values():
            if page.id.startswith(("map/", "sharing/")):
                path = CHECKOUT[language] / f"{page.id}.md"
                raw += len(path.read_text(encoding="utf-8"))
                cleaned += len(page.text)
    assert cleaned < raw * 0.65


def test_the_service_reads_the_docs_of_this_checkout() -> None:
    assert USER_DOCS == load_docs(CHECKOUT)
    assert "map/filter" in USER_DOCS["en"] and "map/filter" in USER_DOCS["de"]


def test_the_index_is_in_the_cached_instructions_and_stays_small() -> None:
    instructions = static_instructions()
    assert instructions[-1] == DOCS_INDEX
    assert "- filter: " in DOCS_INDEX
    # Sent with every model call: a few thousand tokens at most. Past this,
    # shorten the descriptions.
    assert len(DOCS_INDEX) < 15_000


# docs_read


def _page(page_id: str, text: str) -> DocPage:
    return DocPage(page_id, page_id.rsplit("/", 1)[-1].title(), "d", text)


DOCS = {
    "en": {
        "map/filter": _page("map/filter", "# Filter\n\nClick `+ Add Expression`."),
        "map/layers": _page("map/layers", "# Layers"),
        "sharing/public": _page("sharing/public", "# Publish"),
        "map/long": _page("map/long", "# Long\n\n" + "word " * MAX_PAGE_CHARS),
        "map/parts": _page(
            "map/parts",
            "# Parts\n\n"
            + "".join(
                f"## Part {n}\n\n" + "word " * (MAX_PAGE_CHARS // 20) + "\n\n"
                for n in range(1, 7)
            )
            + "```bash\n# not a heading\n```",
        ),
    },
    "de": {
        "map/filter": _page("map/filter", "# Filter\n\nKlicken Sie `+ Ausdruck`."),
    },
}


async def _read(
    page: str, locale: str = "en", env: object = None, section: str | None = None
) -> dict:
    env = env or tool_env(fake_clients(), locale=locale)  # type: ignore[arg-type]
    args = DocsReadInput(page=page, section=section)
    result = await read_from(DOCS)(env, args)  # type: ignore[arg-type]
    return result.model_dump(exclude_none=True)


async def test_docs_read_serves_the_page_in_the_interface_language() -> None:
    result = await _read("map/filter", "de")
    assert result == {
        "page": "map/filter",
        "language": "de",
        "title": "Filter",
        "text": "# Filter\n\nKlicken Sie `+ Ausdruck`.",
    }


async def test_docs_read_falls_back_to_english() -> None:
    result = await _read("map/layers", "de")
    assert result["language"] == "en"
    assert result["text"] == "# Layers"


async def test_an_unknown_page_is_refused_with_the_nearest_ones() -> None:
    with pytest.raises(InputInvalid, match="map/filter"):
        await _read("map/filters")
    with pytest.raises(InputInvalid, match="no page"):
        await _read("../../etc/passwd")


async def test_a_long_page_is_cut_and_says_so() -> None:
    result = await _read("map/long")
    assert len(result["text"]) <= MAX_PAGE_CHARS
    assert result["truncated"] is True


async def test_a_cut_page_names_what_it_left_out_and_reads_on_by_section() -> None:
    first = await _read("map/parts")
    assert first["truncated"] is True and len(first["text"]) <= MAX_PAGE_CHARS
    # Cut where a section starts, so the parts join up again.
    assert first["left_out"] == ["Part 4", "Part 5", "Part 6"]
    assert "section" in first["note"]
    rest = await _read("map/parts", section=first["left_out"][0])
    assert rest["section"] == "Part 4"
    assert "truncated" not in rest
    assert first["text"] + rest["text"] == DOCS["en"]["map/parts"].text


async def test_a_section_is_found_by_its_heading_in_any_case() -> None:
    result = await _read("map/parts", section="## part 6")
    assert result["text"].startswith("## Part 6")


async def test_an_unknown_section_is_refused_with_the_pages_headings() -> None:
    with pytest.raises(InputInvalid, match="Part 1, Part 2") as caught:
        await _read("map/parts", section="Part 9")
    # A shell comment in a code block is no heading.
    assert "not a heading" not in str(caught.value)


async def test_parts_of_a_page_read_already_do_not_count_as_pages() -> None:
    env = tool_env(fake_clients())
    await _read("map/parts", env=env)
    await _read("map/parts", env=env, section="Part 4")
    await _read("map/filter", env=env)
    await _read("map/parts", env=env, section="Part 6")
    assert MAX_PARTS_PER_ANSWER == 4
    # Four parts in all: two pages read in two parts each at most.
    with pytest.raises(ToolFailed, match="four parts"):
        await _read("map/filter", env=env, section="Filter")
    # The same part again counts once.
    await _read("map/parts", env=env, section="Part 4")


def _parts(page_id: str, language: str) -> list[str]:
    """Every part of a real page, read on from each part's first left-out
    section, each in an answer of its own."""
    read = read_from(USER_DOCS)
    parts: list[str] = []
    section = None
    while True:
        env = tool_env(fake_clients(), locale=language)  # type: ignore[arg-type]
        result = asyncio.run(read(env, DocsReadInput(page=page_id, section=section)))
        assert len(result.text) <= MAX_PAGE_CHARS
        parts.append(result.text)
        if not result.truncated:
            return parts
        assert result.left_out
        section = result.left_out[0]


LONG_PAGES = [
    (language, page.id)
    for language, pages in USER_DOCS.items()
    for page in pages.values()
    if len(page.text) > MAX_PAGE_CHARS
]


@pytest.mark.parametrize(("language", "page_id"), LONG_PAGES)
def test_every_part_of_a_long_real_page_can_be_read(
    language: str, page_id: str
) -> None:
    parts = _parts(page_id, language)
    assert len(parts) > 1
    assert "".join(parts) == USER_DOCS[language][page_id].text  # type: ignore[index]


async def test_an_answer_reads_at_most_two_pages() -> None:
    env = tool_env(fake_clients())
    await _read("map/filter", env=env)
    await _read("map/layers", env=env)
    # A page read already is served again without counting.
    await _read("map/filter", env=env)
    assert MAX_PAGES_PER_ANSWER == 2
    with pytest.raises(ToolFailed, match="two docs pages"):
        await _read("sharing/public", env=env)


async def test_docs_read_runs_through_execute_and_not_over_mcp() -> None:
    env = tool_env(fake_clients())
    result = await execute(DOCS_READ, env, {"page": "map/filter"})
    assert result["page"] == "map/filter"
    assert DOCS_READ not in MCP_TOOLS


async def test_a_run_reads_pages_in_the_interface_language_and_each_answer_anew(
    repo: Repository, settings: AssistantSettings
) -> None:
    """Through the run machinery: the run's locale reaches docs_read, the third
    page of an answer is refused, and the next answer may read pages again."""
    pages = ["map/filter", "map/layers", "sharing/public"]
    first = ScriptedModel([("docs_read", {"page": page}) for page in pages])
    conversation_id = UUID(
        str((await repo.create_conversation(UUID(int=1), "none", None, None))["id"])
    )

    async def answer(script: ScriptedModel, text: str) -> list[object]:
        manager = RunManager(
            repo,
            InMemoryEventBus(),
            settings,
            owner="a",
            agent_factory=lambda model: build_agent(script.model),
            tool_services=fake_clients(),
        )
        run_id, _ = await manager.start_run(
            conversation_id,
            UUID(int=1),
            text,
            parse_context(None),
            locale="de",
            login=StaticLogin(None),
        )
        await manager.wait(run_id)
        return [event for _, event in await repo.list_events(run_id)]

    events = await answer(first, "Wie filtere ich einen Layer?")
    returned = [e.output for e in events if isinstance(e, ToolReturned)]
    assert [(r["page"], r["language"]) for r in returned] == [
        ("map/filter", "de"),
        ("map/layers", "de"),
    ]
    [failed] = [e for e in events if isinstance(e, ToolFailedEvent)]
    assert "two docs pages" in failed.error

    # The second answer's history holds the first answer's four responses.
    second = ScriptedModel(
        [("unused", {})] * 4 + [("docs_read", {"page": "sharing/public"})]
    )
    events = await answer(second, "Und wie veröffentliche ich die Karte?")
    [returned_again] = [e.output for e in events if isinstance(e, ToolReturned)]
    assert (returned_again["page"], returned_again["language"]) == (
        "sharing/public",
        "de",
    )
