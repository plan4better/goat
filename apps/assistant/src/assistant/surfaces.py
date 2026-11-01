"""Where the dock can be (spec §6.3) and the languages it answers in (§4.8).

The surface id is what packs, the per-surface kill switch and the eval set key
on. New surfaces are added here and in ``assistant.context``.
"""

from typing import Literal, get_args

Surface = Literal[
    "catalog",
    "project.map",
    "project.workflows",
    "project.layouts",
    "project.dashboard",
    "none",
]
SURFACES: tuple[Surface, ...] = get_args(Surface)

#: The web app's UI languages.
Locale = Literal["en", "de"]
