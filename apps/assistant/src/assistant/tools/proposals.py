"""Page-state proposals (spec §8.2): a suggestion card the page applies to its
own state when the user clicks Apply. The assistant saves nothing.

The ``proposal`` data part is a contract with the web app's surface adapters
(plan 4); ``version`` changes when its shape does.
"""

from collections.abc import Sequence
from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field
from pydantic_ai.exceptions import ToolFailed

from assistant.surfaces import Surface
from assistant.tools.runtime import ToolEnv

#: The keys of a proposal's rows that the web app translates. A catalog facet
#: row is the one exception: its key is the facet's filter parameter
#: (``license``, ``themes``, …; the catalog's ``goat:filter_param``), labelled
#: as the catalog page labels that filter. Rows are built only by ``proposal_row`` and
#: ``facet_row``.
ProposalRowKey = Literal[
    "q",
    "from",
    "to",
    "nuts",
    "sortby",
    "number_matched",
]


class ProposalRow(BaseModel):
    #: A ``ProposalRowKey``, or a catalog facet's filter parameter.
    k: str
    #: Display text.
    v: str


def proposal_row(key: ProposalRowKey, value: str) -> ProposalRow:
    return ProposalRow(k=key, v=value)


def facet_row(parameter: str, values: Sequence[str]) -> ProposalRow:
    """A catalog facet filter: keyed by its filter parameter."""
    return ProposalRow(k=parameter, v=", ".join(values))


class ProposalTarget(BaseModel):
    project_id: UUID
    name: str | None = None


class CatalogFiltersPayload(BaseModel):
    """The catalog page's own state names (``apps/web/lib/catalog/searchQuery.ts``)."""

    q: str | None = None
    facets: dict[str, list[str]] = Field(default_factory=dict)
    from_date: date | None = Field(default=None, serialization_alias="from")
    to_date: date | None = Field(default=None, serialization_alias="to")
    nuts: list[str] = Field(default_factory=list)
    sortby: str | None = None
    number_matched: int


class Proposal(BaseModel):
    version: Literal[1] = 1
    kind: Literal["catalog.filters"]
    #: The surface whose adapter applies it.
    surface: Surface
    #: The project it applies to (spec §10: proposals always name their target).
    target: ProposalTarget | None
    title: str
    rows: list[ProposalRow]
    payload: CatalogFiltersPayload


class ProposalShown(BaseModel):
    proposal_id: str
    status: Literal["shown"] = "shown"
    note: str = (
        "The proposal is shown to the user as a card. Nothing changes until the "
        "user applies it."
    )
    number_matched: int | None = None


async def show(
    env: ToolEnv, proposal: Proposal, *, number_matched: int | None = None
) -> ProposalShown:
    if env.emit_data is None:
        raise ToolFailed("Proposals can only be shown in the GOAT assistant.")
    # Nulls are kept: the adapters read a fixed shape.
    part_id = await env.emit_data(
        "proposal", proposal.model_dump(mode="json", by_alias=True)
    )
    return ProposalShown(proposal_id=part_id, number_matched=number_matched)
