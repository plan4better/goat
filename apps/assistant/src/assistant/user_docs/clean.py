"""A Docusaurus page as plain text for the model.

The docs are MDX: Markdown with JSX for screenshots, videos, layout boxes and
the numbered steps (a ``step-number`` and a ``content`` div). The model needs
the words, the steps in order, the tables, the code and the interface labels
(``<code>`` and ``<b>``); the rest is markup it would read for nothing.

Only the tags named here are changed; any other ``<...>`` stays as written, so
a placeholder such as ``<version>`` in a command survives. Fenced code and
inline code are never touched.
"""

import html
import re
import textwrap

_FENCE = re.compile(r"^[ \t]*(```|~~~)")
_INLINE_CODE = re.compile(r"`[^`\n]+`")
_COMMENT = re.compile(r"<!--.*?-->", re.S)
_IMPORT = re.compile(r"^[ \t]*import\s.+\sfrom\s+['\"][^'\"]+['\"];?[ \t]*$", re.M)
_STEP = re.compile(
    r"<div\s+class=\"step-number\">\s*(\d+)\s*</div>\s*<div\s+class=\"content\">\s*"
)
_TAG = re.compile(r"<(/?)([A-Za-z][\w.]*)")
_MD_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_ADMONITION = re.compile(r"^[ \t]*:{3,}(\w+)(?:[ \t]+(.*?))?[ \t]*$", re.M)
_ADMONITION_END = re.compile(r"^[ \t]*:{3,}[ \t]*$", re.M)
#: A heading's own id (``## Answers {#answers}``), for links on the site.
_HEADING_ID = re.compile(r"^(#{1,6} .*?)[ \t]*\{#[\w-]+\}[ \t]*$", re.M)
_ATTRIBUTE = (
    r"{name}=(?:\"([^\"]*)\"|\{{\"((?:[^\"\\]|\\.)*)\"\}}|\{{`((?:[^`\\]|\\.)*)`\}})"
)

#: Left out with what they hold: pictures, videos, embedded players and
#: interactive components, which have no text for the model.
_DROPPED = frozenset(
    {"img", "Video", "iframe", "DocsSectionCards", "ImpedanceFunction"}
)
#: Replaced by what they stand for in Markdown, opening and closing alike.
_MARKS = {"code": "`", "button": "`", "b": "**", "strong": "**", "i": "*", "em": "*"}
#: Blocks: their tags become line breaks.
_BLOCKS = frozenset({"div", "p", "ul", "ol", "br", "Tabs", "MathJax.Provider"})
#: Wrappers whose tags go and whose text stays.
_UNWRAPPED = frozenset({"a", "span", "u", "sub", "sup", "DocsHero"})
_KNOWN = (
    _DROPPED | set(_MARKS) | _BLOCKS | _UNWRAPPED | {"li", "TabItem", "MathJax.Node"}
)


def _tag_end(text: str, start: int) -> int:
    """The index after the ``>`` that closes the tag opened at ``start``:
    a ``>`` inside a quoted value or a JSX expression (``style={{...}}``,
    ``formula={"..."}``) does not close it."""
    depth = 0
    quote = ""
    i = start + 1
    while i < len(text):
        char = text[i]
        if quote:
            if char == "\\":
                i += 1
            elif char == quote:
                quote = ""
        elif char in "\"'`" and (depth or text[i - 1] == "="):
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        elif char == ">" and depth == 0:
            return i + 1
        i += 1
    return len(text)


def _attribute(tag: str, name: str) -> str:
    match = re.search(_ATTRIBUTE.format(name=name), tag)
    if match is None:
        return ""
    if match.group(1) is not None:
        return match.group(1)
    # A JS string or template literal: ``\\`` is one backslash.
    literal = match.group(2) if match.group(2) is not None else match.group(3)
    return " ".join(re.sub(r"\\(.)", r"\1", literal).split())


def _closing_index(text: str, name: str, start: int) -> int:
    end = text.find(f"</{name}>", start)
    return len(text) if end < 0 else end + len(name) + 3


def _tags(text: str) -> str:
    """The known JSX and HTML tags replaced, left to right."""
    out: list[str] = []
    i = 0
    for match in _TAG.finditer(text):
        if match.start() < i or match.group(2) not in _KNOWN:
            continue
        out.append(text[i : match.start()])
        end = _tag_end(text, match.start())
        tag = text[match.start() : end]
        closing, name = match.group(1) == "/", match.group(2)
        self_closing = tag.endswith("/>")
        i = end
        if name in _DROPPED:
            if not closing and not self_closing:
                i = _closing_index(text, name, end)
            # No double space, or space before a full stop, where an inline
            # picture was.
            if out and out[-1].endswith(" "):
                if text[i : i + 1] == " ":
                    i += 1
                elif text[i : i + 1] in (".", ",", ";", ":", ")"):
                    out[-1] = out[-1].rstrip(" ")
        elif name in _MARKS:
            out.append(_MARKS[name])
        elif name in _BLOCKS:
            out.append("\n")
        elif name == "li":
            if not closing:
                # Items follow each other line by line.
                out.append("\n- ")
                out[:-1] = ["".join(out[:-1]).rstrip()]
        elif name == "TabItem":
            label = "" if closing else _attribute(tag, "label")
            out.append(f"\n\n**{label}**\n\n" if label else "\n")
        elif name == "MathJax.Node":
            out.append(f"\n\n{_attribute(tag, 'formula')}\n\n")
        # _UNWRAPPED: the tag goes, its text stays.
    out.append(text[i:])
    return "".join(out)


def _admonition(match: re.Match[str]) -> str:
    kind, title = match.group(1), (match.group(2) or "").strip()
    if not title or title.casefold() == kind.casefold():
        title = kind.capitalize()
    return f"{title}:"


def _prose(text: str) -> str:
    """Markdown and JSX outside code, cleaned. Inline code is set aside first
    and put back as it was."""
    kept: list[str] = []

    def keep(match: re.Match[str]) -> str:
        kept.append(match.group(0))
        return f"\x00{len(kept) - 1}\x00"

    text = _INLINE_CODE.sub(keep, text)
    text = _COMMENT.sub("", text)
    text = _IMPORT.sub("", text)
    text = _STEP.sub(lambda m: f"\n\n{m.group(1)}. ", text)
    text = _tags(text)
    text = _MD_IMAGE.sub("", text)
    text = _MD_LINK.sub(r"\1", text)
    text = _ADMONITION_END.sub("", text)
    text = _ADMONITION.sub(_admonition, text)
    text = _HEADING_ID.sub(r"\1", text)
    text = html.unescape(text)
    return re.sub("\x00(\\d+)\x00", lambda m: kept[int(m.group(1))], text)


def _tidy(text: str) -> str:
    """No whitespace-only lines, no indentation left over from the JSX (a
    nested Markdown list keeps its own), at most one blank line in a row."""
    lines = []
    for line in text.splitlines():
        line = line.rstrip()
        if not re.match(r"[ \t]+([-*+]|\d+\.) ", line):
            line = line.lstrip()
        lines.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def clean(markdown: str) -> str:
    """A page's Markdown (without its front matter) as plain text."""
    parts: list[str] = []
    prose: list[str] = []
    block: list[str] = []
    fence = ""
    for line in markdown.splitlines():
        match = _FENCE.match(line)
        if not fence:
            if match:
                parts.append(_tidy(_prose("\n".join(prose))))
                prose, block, fence = [], [line], match.group(1)
            else:
                prose.append(line)
            continue
        block.append(line)
        if match and not line.strip().strip(fence[0]):
            # Kept as written, without the indentation of the step around it.
            parts.append(textwrap.dedent("\n".join(block)))
            block, fence = [], ""
    if block:
        parts.append(textwrap.dedent("\n".join(block)))
    parts.append(_tidy(_prose("\n".join(prose))))
    return "\n\n".join(part for part in parts if part)
