from pydantic import BaseModel, ConfigDict, Field

#: A tuple accepts a JSON array; its items stay strict.
LAX = Field(strict=False)


class StyleModel(BaseModel):
    """Base of every GOAT Style model: unknown keys are errors (`unknown_key`).

    Rules a schema can express raise `PydanticCustomError(<spec code>, message)`,
    so `goatlib.style.parse` keeps the specification's code.

    Validation is strict about JSON types (a number written as text is an error),
    because callers store the document they validated, not what a lax parse would
    make of it. Tuples are the exception: JSON has only arrays, so every tuple is
    annotated `LAX` (lax for the container, strict for its items). Infinity and
    NaN are refused: they are not JSON, and JSONB cannot store them.
    """

    model_config = ConfigDict(
        extra="forbid", populate_by_name=True, allow_inf_nan=False, strict=True
    )
