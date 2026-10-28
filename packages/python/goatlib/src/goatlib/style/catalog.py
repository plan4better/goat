"""The palette and icon catalogues GOAT Style refers to by id.

Both are data owned by goatlib (`style/data/`): palettes are published to the web
and the AI from here. Icons are named `<library>:<name>`; `goat` is GOAT's built-in
library (the icons of `apps/web/public/assets/icons/maki`), `emoji` the emoji by
their code points (`emoji:1f525`, images in `apps/web/public/assets/icons/emoji`,
built by `apps/web/scripts/build-emoji.mjs`). Uploaded icons are `asset:<id>` and
belong to no library.
"""

import json
from dataclasses import dataclass
from functools import cache
from importlib import resources
from types import MappingProxyType
from typing import Any, Literal, Mapping


@dataclass(frozen=True)
class Palette:
    id: str
    name: str
    kind: Literal["sequential", "diverging", "qualitative"]
    colors: tuple[str, ...]
    colorblind_safe: bool | None
    #: A scheme per class count where the source has one (ColorBrewer); `colors`
    #: is the longest.
    variants: Mapping[int, tuple[str, ...]]


def _read(name: str) -> Any:
    return json.loads(
        resources.files("goatlib.style")
        .joinpath("data", name)
        .read_text(encoding="utf-8")
    )


@cache
def palettes() -> Mapping[str, Palette]:
    return {
        p["id"]: Palette(
            id=p["id"],
            name=p["name"],
            kind=p["kind"],
            colors=tuple(p["colors"]),
            colorblind_safe=p.get("colorblind_safe"),
            variants=MappingProxyType(
                {int(n): tuple(c) for n, c in p.get("variants", {}).items()}
            ),
        )
        for p in _read("palettes.json")
    }


def palette_colors(ref: str | list[str]) -> list[str] | None:
    """The colors of a catalogue id or an inline list; None for an unknown id."""
    if isinstance(ref, list):
        return ref
    palette = palettes().get(ref)
    return list(palette.colors) if palette else None


#: The emoji groups, in the picker's order.
EMOJI_GROUPS: tuple[str, ...] = (
    "smileys_emotion",
    "people_body",
    "animals_nature",
    "food_drink",
    "travel_places",
    "activities",
    "objects",
    "symbols",
    "flags",
)


@cache
def icon_libraries() -> Mapping[str, frozenset[str]]:
    """Icon libraries by prefix, each with its icon names."""
    toned = (code for e in emoji() for code in e.get("tones", ()))
    return {
        "goat": icon_names(),
        "emoji": frozenset([*(e["code"] for e in emoji()), *toned]),
    }


def keeps_colors(ref: str) -> bool:
    """Whether an icon keeps its own colors (uploads and emoji) instead of taking
    the marker's."""
    return ref.startswith(("asset:", "emoji:"))


@cache
def emoji() -> list[dict[str, Any]]:
    """The emoji library in Unicode order: `{code, name, group, keywords}`, and
    `tones` (five toned codes, light to dark) for emoji with skin tones."""
    return _read("emoji.json")


@cache
def icon_names() -> frozenset[str]:
    return frozenset(_read("icons.json"))


def icon_groups() -> list[dict[str, Any]]:
    """The library icons in the groups the icon picker shows: `{id, label_key, icons}`."""
    return _read("icon_groups.json")
