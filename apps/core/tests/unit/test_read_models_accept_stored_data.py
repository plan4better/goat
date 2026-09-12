"""A read model must accept anything the database can hold.

The same classes serve as storage model, input schema and response schema, so a
rule meant for input — `max_length`, a format assertion — also runs when a row
is turned back into a response. When stored data violates it there is no way
out: the row exists, the user cannot edit it, and the whole response fails. One
catalog layer with a 2,440-character description stopped an entire project from
loading that way.

Length belongs on input. This test fails when a constraint reaches the read
path, which is the only reliable way to keep it off: nothing else notices until
data that violates it arrives.
"""

from uuid import uuid4

import pytest
from annotated_types import MaxLen, MinLen
from core.schemas.bundle import BundleArtifactSummary, BundleRead
from core.schemas.layer import (
    IFeatureStandardLayerRead,
    IFeatureStreetNetworkLayerRead,
    IFeatureToolLayerRead,
    IRasterLayerRead,
    ITableLayerRead,
)
from core.schemas.project import (
    IFeatureStandardProjectRead,
    IFeatureStreetNetworkProjectRead,
    IFeatureToolProjectRead,
    ILayerProjectGroupRead,
    IRasterProjectRead,
    ITableProjectRead,
)

READ_MODELS = [
    BundleRead,
    IFeatureStandardLayerRead,
    IFeatureToolLayerRead,
    IFeatureStreetNetworkLayerRead,
    ITableLayerRead,
    IRasterLayerRead,
    IFeatureStandardProjectRead,
    IFeatureToolProjectRead,
    IFeatureStreetNetworkProjectRead,
    ITableProjectRead,
    IRasterProjectRead,
    ILayerProjectGroupRead,
]

#: Fields whose value this service produces rather than stores — a constraint
#: on one of these cannot be violated by data arriving from elsewhere.
SELF_PRODUCED: set[str] = set()


@pytest.mark.parametrize("model", READ_MODELS, ids=lambda m: m.__name__)
def test_no_read_field_bounds_the_length_of_stored_data(model: type) -> None:
    bounded = {
        name: [
            type(meta).__name__
            for meta in field.metadata
            if isinstance(meta, (MaxLen, MinLen))
        ]
        for name, field in model.model_fields.items()
        if name not in SELF_PRODUCED
        and any(isinstance(meta, (MaxLen, MinLen)) for meta in field.metadata)
    }

    assert not bounded, (
        f"{model.__name__} would refuse to serialise a row whose {sorted(bounded)} "
        "exceeds a length the database happily stored. Put the bound on the "
        "create/update schema instead, and override the field on the read model."
    )


def test_bundle_read_tolerates_stored_shapes_it_cannot_validate() -> None:
    """The length rule above is one case of a broader one: a read model must
    survive a column holding something its type does not describe.

    `dataset_metadata` is free-form JSONB and `build_status` is text, so both
    can hold a value no release wrote deliberately — a merge that produced an
    array, a status from a newer version. Since a listing builds one DTO per
    bundle, refusing either would fail every bundle the caller asked for.
    """
    base = dict(
        id=uuid4(),
        user_id=uuid4(),
        folder_id=uuid4(),
        name="b",
        bundle_type="street_network",
        status="ready",
    )

    for stored in ([None, {"data_reference_year": 2025}], "not a document", 7):
        assert BundleRead(**base, dataset_metadata=stored).dataset_metadata is None

    assert BundleRead(**base, dataset_metadata={"license": "ODbL"}).dataset_metadata

    # Content, not just shape. Every one of these violates a rule on
    # `DatasetProvenance` — which is the *input* contract, and the column has
    # no equivalent: nothing stops a write, an older release or a hand-edit
    # putting them there, and one such row must not fail the whole listing.
    for stored in (
        {"geographical_code": "DE-BY"},  # not ISO 3166-1 / a continent
        {"distributor_email": "ask the city hall"},  # not an email
        {"license": "L" * 300},  # over max_length
        {"lineage": "x" * 600},  # over max_length
        {"data_reference_year": "unknown"},  # not an int
        {"publisher": "someone"},  # a key this release does not know
    ):
        assert BundleRead(**base, dataset_metadata=stored).dataset_metadata == stored
    assert (
        BundleArtifactSummary(
            kind="street_network_graph", state="failed", build_status="from_the_future"
        ).build_status
        == "from_the_future"
    )
