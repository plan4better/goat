"""The data policy (spec §4.7), applied to every tool flagged ``returns_data``.

Standard sends what the user can see, size-capped. Restricted sends field names
and types, counts, min/max, histograms (class breaks) and the distinct values of
fields with at most ``LOW_CARDINALITY_LIMIT`` of them; never rows, features,
geometries, or aggregates outside that list (mean, standard deviation, sums).
Min/max and class breaks need at least ``MIN_RESTRICTED_GROUP`` features with a
value, and a distinct value (listed, or a group's key) needs as many holding it.

A data tool's output model says how it is reduced, with a ``restricted()``
method. An output without one is withheld entirely: a new data tool that forgot
its Restricted form fails closed, not open.
"""

from typing import Literal, Protocol, runtime_checkable

from pydantic import BaseModel

from assistant.llm.types import DataPolicy

LOW_CARDINALITY_LIMIT = 50
#: Under Restricted, fewer features than this are not allowed to return their
#: values: a filter, or a layer, that leaves one feature would make its
#: minimum, maximum and class breaks that feature's own values (a result layer
#: of one row: its sum). So minimum and maximum, of a field or of the area,
#: are withheld below it, filtered or not, and so is a value of a field
#: (listed, or a group's key) that fewer features hold: a filter may not
#: pick one either (``_guard_restricted_filter``). A filtered count below it is
#: withheld too, by the project tools and by the workflow check alike, since
#: it says whether a feature exists ("none" against "one"); an unfiltered
#: count is the layer's size and stays. Class breaks are capped so every
#: class holds at least this many features with a value, filtered or not:
#: quantile breaks over as many classes as values are the values themselves.
#: ``k`` break points make ``k + 1`` classes.
MIN_RESTRICTED_GROUP = 5

RESTRICTED_REASON = (
    "Withheld: the organization's data policy (Restricted) does not allow sending "
    "this to the AI. Tell the user that the data policy keeps this from you, and "
    "what you can do instead."
)


class Withheld(BaseModel):
    withheld: Literal[True] = True
    reason: str = RESTRICTED_REASON


@runtime_checkable
class Restrictable(Protocol):
    def restricted(self) -> BaseModel: ...


def apply_policy(policy: DataPolicy, result: BaseModel) -> BaseModel:
    if policy == "standard":
        return result
    if isinstance(result, Restrictable):
        reduced = result.restricted()
        # A reduction that hands back the very object it was given reduced
        # nothing: fail closed.
        return Withheld() if reduced is result else reduced
    return Withheld()
