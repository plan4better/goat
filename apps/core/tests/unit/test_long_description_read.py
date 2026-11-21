"""A description already in the database must never break reading it back.

`ContentBaseAttributes.description` carries `max_length=2000`, which Pydantic
enforces whenever the model is validated — including when a READ model is built
out of a row. The column itself is `Text`, and a promoted catalog layer copies
the provider's description verbatim: 582 of the catalog's 34,760 items are
longer than 2000 characters, the longest 11,559. One such layer in a project
made `GET /project/{id}/layer` fail outright, so the whole project stopped
loading rather than that one layer.

The limit belongs on input. Reading is not the place to discover that stored
data is too long — there is nothing the user can do about it.
"""

import pytest
from core.db.models._base_class import ContentBaseAttributes
from core.schemas.project import IFeatureStandardProjectRead

# Longer than the INPUT limit on purpose: this asserts that reading applies no
# bound at all, not merely a bigger one. A row can predate any limit we set.
LONG = "Welche Ladeinfrastruktur " * 2_400  # 60,000 characters


def _project_layer(description: str) -> dict:
    return {
        "id": 1,
        "layer_id": "4d84242c-873d-4923-83b2-9d1862a8168c",
        "name": "Ladebedarf",
        "description": description,
        "type": "feature",
        "feature_layer_type": "standard",
        "feature_layer_geometry_type": "polygon",
    }


def test_a_description_longer_than_the_input_limit_still_reads_back() -> None:
    read = IFeatureStandardProjectRead(**_project_layer(LONG))

    assert read.description == LONG


def test_an_ordinary_description_still_reads_back() -> None:
    read = IFeatureStandardProjectRead(**_project_layer("Short one"))

    assert read.description == "Short one"


def test_the_catalog_s_longest_description_is_accepted_on_input() -> None:
    """11,559 characters is the longest the catalog actually publishes."""
    ContentBaseAttributes(name="x", description="x" * 11_559)


def test_input_is_still_bounded() -> None:
    """The limit stays where it can be acted on: what a caller submits."""
    with pytest.raises(Exception) as excinfo:
        ContentBaseAttributes(name="x", description="x" * 60_000)

    assert "50000" in str(excinfo.value).replace(",", "")
