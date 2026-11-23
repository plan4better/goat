"""The key `properties` in a write of a layer, a project layer or a layer group.

Styles and map state are saved through routes of their own. A body that still
carries `properties` (whatever its value) is refused with 422 and one sentence
that names those routes, so the client shows an error instead of a save that
stored nothing. Other unknown keys are ignored.
"""

from typing import Any

from fastapi import HTTPException, status
from pydantic import BaseModel, model_validator

from core.schemas.error import ERROR_MAPPING

PROPERTIES_REFUSED = (
    "`properties` is not accepted. Styles are saved through the style routes: "
    "/project/{project_id}/layer/{layer_project_id}/style for a project layer, "
    "/layer/{layer_id}/style for a dataset. Visibility and other map state are "
    "saved through /project/{project_id}/layer/{layer_project_id}/map-state, "
    "/project/{project_id}/group/{group_id}/map-state or the `visible` field of "
    "the layer tree."
)


class PropertiesRefused(HTTPException):
    """422 whose `detail` is the sentence.

    An HTTPException, not a ValueError: pydantic turns a ValueError into a list
    of validation errors, while this one passes through validation unchanged,
    so the answer's `detail` is the sentence wherever the model is validated
    (FastAPI's body, a `TypeAdapter`, `HTTPErrorHandler` through the mapping
    below)."""

    def __init__(self) -> None:
        super().__init__(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=PROPERTIES_REFUSED,
        )

    def __str__(self) -> str:
        return PROPERTIES_REFUSED


# `HTTPErrorHandler` answers with the mapped status and `str(exc)`.
ERROR_MAPPING[PropertiesRefused] = status.HTTP_422_UNPROCESSABLE_ENTITY


class RefusesProperties(BaseModel):
    """Refuses a body with the key `properties`. Only for write models: read
    models are built from rows, which keep a `properties` column."""

    @model_validator(mode="before")
    @classmethod
    def refuse_properties(cls, data: Any) -> Any:
        if isinstance(data, dict) and "properties" in data:
            raise PropertiesRefused()
        return data
