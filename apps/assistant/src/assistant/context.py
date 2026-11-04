"""Page context (spec §6.3): what the page a message was sent from says about
itself, validated per surface.

Context is a hint, never an authorization: it carries IDs and page state, and
the tools re-check every access with the run's token. It is stored with the
user message (so a reopened conversation shows its chips) and rendered into a
short note for the model after the cached prompt prefix (``assistant.prompt``).
Unknown keys are rejected, so a page cannot put free text into the prompt.
"""

import re
from collections.abc import Mapping
from datetime import date
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    field_validator,
    model_validator,
)

from assistant.surfaces import Surface

_FACET_KEY = r"^[a-z][a-z0-9_]{0,39}$"
NUTS_ID_PATTERN = r"^[A-Z]{2}[A-Z0-9]{0,3}$"
#: Fields with no reason to hold prose are constrained (Decision T19).
SORTBY_PATTERN = r"^-?[A-Za-z0-9_.:]+(,-?[A-Za-z0-9_.:]+)*$"
RECORD_ID_PATTERN = r"^[A-Za-z0-9._:-]{1,300}$"
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")

FacetValue = Annotated[str, Field(max_length=200)]
FacetValues = Annotated[list[FacetValue], Field(max_length=50)]
FacetKey = Annotated[str, Field(pattern=_FACET_KEY)]
NutsId = Annotated[str, Field(pattern=NUTS_ID_PATTERN)]
Longitude = Annotated[float, Field(ge=-180, le=180)]
Latitude = Annotated[float, Field(ge=-90, le=90)]


class _Context(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class SourceRef(_Context):
    """A project the user referenced with an @ mention (spec §10): readable as a
    source through tools that take its explicit ID, never the conversation's target."""

    kind: Literal["project"] = "project"
    id: UUID
    #: Stripped first, so a name of only whitespace is empty and rejected.
    name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
    ]


class _Page(_Context):
    sources: list[SourceRef] = Field(default_factory=list, max_length=10)

    @field_validator("sources")
    @classmethod
    def _one_entry_per_project(cls, sources: list[SourceRef]) -> list[SourceRef]:
        """A project mentioned twice is listed once, the first mention wins."""
        first: dict[UUID, SourceRef] = {}
        for source in sources:
            first.setdefault(source.id, source)
        return list(first.values())


class NoPage(_Page):
    """Home, content, settings: no surface adapter and no page state. The core
    and read-only project packs are loaded; project tools need a project_id
    here (Decision T16)."""

    surface: Literal["none"] = "none"


class CatalogContext(_Page):
    surface: Literal["catalog"]
    q: str | None = Field(default=None, max_length=500)
    #: Selected values per facet parameter (``themes``, ``license``, …).
    facets: dict[FacetKey, FacetValues] = Field(default_factory=dict, max_length=20)
    from_date: date | None = Field(default=None, alias="from")
    to_date: date | None = Field(default=None, alias="to")
    nuts: list[NutsId] = Field(default_factory=list, max_length=20)
    sortby: str | None = Field(default=None, max_length=100, pattern=SORTBY_PATTERN)
    selected_record_id: str | None = Field(default=None, pattern=RECORD_ID_PATTERN)

    @field_validator("from_date", "to_date", mode="before")
    @classmethod
    def _iso_date_string(cls, value: object) -> object:
        """Only ``YYYY-MM-DD`` strings: no timestamps, ints or date objects."""
        if value is not None and not (
            isinstance(value, str) and _ISO_DATE.fullmatch(value)
        ):
            raise ValueError("expected a YYYY-MM-DD date string")
        return value

    @model_validator(mode="after")
    def _range_is_ordered(self) -> "CatalogContext":
        if self.from_date and self.to_date and self.from_date > self.to_date:
            raise ValueError("from must not be after to")
        return self


class Viewport(_Context):
    center: tuple[Longitude, Latitude]
    zoom: float = Field(ge=0, le=24)
    bearing: float = Field(default=0, ge=-360, le=360)
    pitch: float = Field(default=0, ge=0, le=90)
    bbox: tuple[Longitude, Latitude, Longitude, Latitude] | None = None


class ProjectMapContext(_Page):
    surface: Literal["project.map"]
    project_id: UUID
    selected_layer_project_id: int | None = Field(default=None, ge=1, strict=True)
    viewport: Viewport | None = None


class ProjectWorkflowsContext(_Page):
    surface: Literal["project.workflows"]
    project_id: UUID
    workflow_id: UUID | None = None


class ProjectLayoutsContext(_Page):
    surface: Literal["project.layouts"]
    project_id: UUID
    layout_id: UUID | None = None


class ProjectDashboardContext(_Page):
    surface: Literal["project.dashboard"]
    project_id: UUID


PageContext = Annotated[
    NoPage
    | CatalogContext
    | ProjectMapContext
    | ProjectWorkflowsContext
    | ProjectLayoutsContext
    | ProjectDashboardContext,
    Field(discriminator="surface"),
]

CONTEXT_ADAPTER: TypeAdapter[PageContext] = TypeAdapter(PageContext)

NO_PAGE = NoPage()

SURFACE_LABELS: dict[Surface, str] = {
    "catalog": "the data catalog",
    "project.map": "a project, Map mode",
    "project.workflows": "a project, Workflows mode",
    "project.layouts": "a project, Layouts mode",
    "project.dashboard": "a project, Dashboard mode",
    "none": "home, content or settings (no project or catalog page open)",
}


def parse_context(raw: Mapping[str, Any] | None) -> PageContext:
    """Validate a request's context. None (a page without an adapter) is
    ``NO_PAGE``. Raises ``pydantic.ValidationError``."""
    if raw is None:
        return NO_PAGE
    return CONTEXT_ADAPTER.validate_python(dict(raw))


def dump_context(page: PageContext) -> dict[str, Any]:
    """The stored form: the page's own field names, unset values left out."""
    dumped: dict[str, Any] = page.model_dump(
        mode="json", by_alias=True, exclude_none=True
    )
    if not dumped.get("sources"):
        dumped.pop("sources", None)
    return dumped


def project_of(page: PageContext) -> UUID | None:
    project_id: UUID | None = getattr(page, "project_id", None)
    return project_id
