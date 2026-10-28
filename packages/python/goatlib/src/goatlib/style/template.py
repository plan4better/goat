"""Label templates (the specification's section 3.4).

`{field name}` is replaced by the feature's value, everything else is literal,
`\\n` breaks the line, and `\\{` and `\\}` are literal braces.
"""

import re

_LIQUID = re.compile(r"\{\{\s*(.+?)\s*\}\}")


def _scan(text: str) -> tuple[list[str], list[str]]:
    fields: list[str] = []
    problems: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text) and text[i + 1] in "{}":
            i += 2
            continue
        if ch == "{":
            end = i + 1
            name_chars: list[str] = []
            while end < len(text) and text[end] not in "{}":
                if text[end] == "\\" and end + 1 < len(text) and text[end + 1] in "{}":
                    name_chars.append(text[end + 1])
                    end += 2
                    continue
                name_chars.append(text[end])
                end += 1
            if end >= len(text) or text[end] == "{":
                problems.append(
                    f"An opening brace at position {i} has no matching closing brace."
                )
                i = end if end > i + 1 else i + 1
                continue
            name = "".join(name_chars)
            if not name.strip():
                problems.append(f"An empty placeholder at position {i}.")
            else:
                fields.append(name)
            i = end + 1
            continue
        if ch == "}":
            problems.append(f"A closing brace at position {i} has no opening brace.")
        i += 1
    return fields, problems


def placeholders(text: str) -> list[str]:
    """The fields a template reads, in order."""
    return _scan(text)[0]


def problems(text: str) -> list[str]:
    """What is wrong with a template: `{{ field }}`, unbalanced or empty braces."""
    found = _scan(text)[1]
    if _LIQUID.search(text):
        found.insert(0, "Labels use {field}, not {{ field }}.")
    return found


def liquid_to_label(text: str) -> str:
    """`{{ name }}` written as the label form `{name}`."""
    return _LIQUID.sub(lambda m: "{" + m.group(1) + "}", text)
