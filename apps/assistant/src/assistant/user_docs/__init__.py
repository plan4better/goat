"""GOAT's user documentation, for questions about GOAT's own interface.

The pages are the docs site's sources (``apps/docs``), English and German,
read once when this module is imported and cleaned to plain text
(``user_docs.clean``). A source checkout reads them where they are, so a dev
stack and the tests need no step of their own; the image has no ``apps/docs``,
so its Dockerfile copies both trees into ``pages/`` next to this module before
the package is built. Either way the docs are the ones of the running version.

The instructions list every English page in one line (``DOCS_INDEX``, in the
cached prefix), and ``docs_read`` serves only what was read here: a requested
page is looked up by its id, never opened as a path. Page ids are the source
paths without ``.md`` (``map/filter``), the same in both languages.
"""

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from assistant.surfaces import Locale
from assistant.user_docs.clean import clean

__all__ = [
    "DOCS_INDEX",
    "INDEX_INTRO",
    "USER_DOCS",
    "DocPage",
    "DocsError",
    "checkout_roots",
    "clean",
    "docs_index",
    "load_docs",
    "load_tree",
    "read_page",
]

HERE = Path(__file__).resolve().parent
#: Where the Dockerfile puts the two trees, ``pages/en`` and ``pages/de``.
BUNDLED = HERE / "pages"
#: The trees in a source checkout, under ``apps/``.
SOURCES: dict[Locale, Path] = {
    "en": Path("docs", "docs"),
    "de": Path("docs", "i18n", "de", "docusaurus-plugin-content-docs", "current"),
}
CATEGORY_FILE = "_category_.json"
INDEX_INTRO = (
    "GOAT's user docs, one line per page (a folder, then its pages: what each "
    'covers). Read one with docs_read(page), e.g. docs_read(page="map/filter").'
)


class DocsError(ValueError):
    """A docs page that cannot be read; the message names the file."""


@dataclass(frozen=True)
class DocPage:
    #: The source path without ``.md``: ``map/filter``.
    id: str
    title: str
    #: From the front matter; empty when the page has none.
    description: str
    #: The page as plain text, its title as the first heading.
    text: str


def _unquoted(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _front_matter(path: Path, source: str) -> tuple[dict[str, str], str]:
    """The front matter's ``key: value`` lines and the text after it. Other
    YAML (lists, nested keys) is skipped: only ``title`` and ``description``
    are read."""
    lines = source.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, source
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        raise DocsError(f"{path}: the front matter is not closed with '---'")
    meta: dict[str, str] = {}
    for line in lines[1:end]:
        key, colon, value = line.partition(":")
        if colon and key.strip() and not line[:1].isspace():
            meta[key.strip()] = _unquoted(value)
    return meta, "\n".join(lines[end + 1 :])


def read_page(path: Path, page_id: str) -> DocPage:
    meta, body = _front_matter(path, path.read_text(encoding="utf-8"))
    text = clean(body)
    heading = next(
        (line[2:].strip() for line in text.splitlines() if line.startswith("# ")),
        None,
    )
    title = meta.get("title") or heading or Path(page_id).name
    if heading is None:
        text = f"# {title}\n\n{text}".strip()
    return DocPage(page_id, title, meta.get("description", ""), text)


def _hidden(folder: Path, root: Path) -> bool:
    """Whether the folder or one above it, up to ``root``, is a category the
    sidebar hides (``"className": "hidden"``): the docs site's llms.txt leaves
    those out too."""
    for current in (folder, *folder.parents):
        category = current / CATEGORY_FILE
        if category.is_file():
            config = json.loads(category.read_text(encoding="utf-8"))
            if "hidden" in str(config.get("className", "")).split():
                return True
        if current == root:
            return False
    return False


def load_tree(root: Path) -> dict[str, DocPage]:
    """Every page under ``root`` outside hidden categories, by id, in order."""
    pages: dict[str, DocPage] = {}
    for path in sorted(root.rglob("*.md")):
        if _hidden(path.parent, root):
            continue
        page_id = path.relative_to(root).with_suffix("").as_posix()
        pages[page_id] = read_page(path, page_id)
    return pages


def load_docs(roots: Mapping[Locale, Path]) -> dict[Locale, dict[str, DocPage]]:
    return {language: load_tree(root) for language, root in roots.items()}


def checkout_roots() -> dict[Locale, Path]:
    """The two trees of the source checkout this module runs from."""
    apps = HERE.parents[3]
    return {language: apps / path for language, path in SOURCES.items()}


def bundled_roots() -> dict[Locale, Path]:
    """The two trees as the Dockerfile copies them into the package."""
    return {language: BUNDLED / language for language in SOURCES}


def docs_roots() -> dict[Locale, Path]:
    """The checkout's trees when they are there, the bundled ones otherwise. A
    service without either does not start: without them it would tell users it
    cannot see the interface."""
    for roots in (checkout_roots(), bundled_roots()):
        if all(root.is_dir() for root in roots.values()):
            return roots
    raise DocsError(
        f"GOAT's user docs are neither in the checkout ({checkout_roots()['en']}) "
        f"nor bundled ({BUNDLED})"
    )


def docs_index(pages: Mapping[str, DocPage]) -> str:
    """The docs list of the instructions: pages grouped by folder, one line
    each, the pages at the top first; empty without pages."""
    if not pages:
        return ""
    lines = [INDEX_INTRO]
    folder = ""
    for parent, name, page in sorted(
        (*page.id.rpartition("/")[::2], page) for page in pages.values()
    ):
        if parent != folder:
            lines.append(f"{parent}/")
            folder = parent
        lines.append(f"- {name}: {page.description or page.title}")
    return "\n".join(lines)


USER_DOCS: dict[Locale, dict[str, DocPage]] = load_docs(docs_roots())
#: The English pages: their ids are the German pages' too.
DOCS_INDEX = docs_index(USER_DOCS["en"])
