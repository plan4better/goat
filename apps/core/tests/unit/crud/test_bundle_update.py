"""What `PUT /bundle/{id}` does to `dataset_metadata`.

The document holds two authorships at once — what the importer read out of the
source, and what the owner typed — so the update merges rather than assigns.
That makes the merge conditional on the payload carrying a document at all,
which is the part worth pinning: a rename and a folder move send no provenance,
and reaching into it anyway raised before either could commit.
"""

from typing import Any
from uuid import uuid4

import pytest
from core.crud.crud_bundle import bundle as crud_bundle
from core.db.models.bundle import Bundle
from core.schemas.bundle import BundleUpdate


class _Session:
    """Enough of an AsyncSession for the merge: it never reads."""

    def add(self, *args: Any) -> None:
        pass

    async def commit(self) -> None:
        pass

    async def refresh(self, *args: Any) -> None:
        pass


def _bundle(dataset_metadata: Any) -> Bundle:
    return Bundle(
        name="original",
        folder_id=uuid4(),
        user_id=uuid4(),
        bundle_type="street_network",
        dataset_metadata=dataset_metadata,
    )


@pytest.mark.asyncio
async def test_update_without_provenance_leaves_it_alone() -> None:
    """A rename or a move carries no document, and must not disturb one."""
    stored = {"license": "ODbL", "attribution": "Overture"}

    renamed = _bundle(dict(stored))
    await crud_bundle.update(
        _Session(), db_obj=renamed, obj_in=BundleUpdate(name="new")
    )
    assert (renamed.name, renamed.dataset_metadata) == ("new", stored)

    folder = uuid4()
    moved = _bundle(dict(stored))
    await crud_bundle.update(
        _Session(), db_obj=moved, obj_in=BundleUpdate(folder_id=folder)
    )
    assert (moved.folder_id, moved.dataset_metadata) == (folder, stored)


@pytest.mark.asyncio
async def test_provenance_merges_and_null_clears() -> None:
    edited = _bundle({"license": "ODbL", "attribution": "Overture"})
    await crud_bundle.update(
        _Session(),
        db_obj=edited,
        obj_in=BundleUpdate(
            dataset_metadata={"lineage": "clipped", "attribution": None}
        ),
    )
    # Absent keeps, sent replaces, null clears.
    assert edited.dataset_metadata == {"license": "ODbL", "lineage": "clipped"}


@pytest.mark.asyncio
async def test_merge_onto_a_non_document_starts_over() -> None:
    """Free-form JSONB can hold a non-object, and an edit has to still land."""
    broken = _bundle([None, {"data_reference_year": 2025}])
    await crud_bundle.update(
        _Session(),
        db_obj=broken,
        obj_in=BundleUpdate(dataset_metadata={"license": "ODbL"}),
    )
    assert broken.dataset_metadata == {"license": "ODbL"}
