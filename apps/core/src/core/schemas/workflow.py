"""
Workflow Schemas
"""

from datetime import datetime
from typing import Any, Dict
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class WorkflowBase(BaseModel):
    """Base schema for workflow."""

    name: str = Field(..., description="Workflow name", max_length=255)
    description: str | None = Field(None, description="Workflow description")
    is_default: bool = Field(False, description="Whether this is the default workflow")
    config: Dict[str, Any] = Field(
        ...,
        description="Workflow configuration (nodes, edges, viewport)",
    )


class WorkflowCreate(WorkflowBase):
    """Schema for creating a workflow."""

    pass


class WorkflowUpdate(BaseModel):
    """Schema for updating a workflow."""

    name: str | None = Field(None, description="Workflow name", max_length=255)
    description: str | None = Field(None, description="Workflow description")
    is_default: bool | None = Field(
        None, description="Whether this is the default workflow"
    )
    config: Dict[str, Any] | None = Field(
        None,
        description="Workflow configuration (nodes, edges, viewport)",
    )
    base_revision: int | None = Field(
        None,
        description=(
            "The revision the change was made on. A save that changes the "
            "workflow on another revision answers 409 changed_elsewhere; without "
            "it the save lands anyway."
        ),
    )


class WorkflowRead(WorkflowBase):
    """Schema for reading a workflow."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID = Field(..., description="Workflow ID")
    project_id: UUID = Field(..., description="Parent project ID")
    thumbnail_url: str | None = Field(
        None, description="Workflow preview thumbnail URL"
    )
    revision: int = Field(..., description="Revision to send as base_revision")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")


# Request examples for OpenAPI documentation
request_examples = {
    "create": {
        "name": "Buffer Analysis",
        "description": "A workflow that buffers points and clips to a boundary",
        "is_default": False,
        "config": {
            "nodes": [],
            "edges": [],
            "viewport": {"x": 0, "y": 0, "zoom": 1},
        },
    },
    "update": {
        "name": "Updated Workflow Name",
        "base_revision": 1,
        "config": {
            "nodes": [
                {
                    "id": "dataset-1",
                    "type": "dataset",
                    "position": {"x": 100, "y": 100},
                    "data": {
                        "type": "dataset",
                        "label": "Input Layer",
                        "layerId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                    },
                },
                {
                    "id": "tool-1",
                    "type": "tool",
                    "position": {"x": 300, "y": 100},
                    "data": {
                        "type": "tool",
                        "processId": "buffer",
                        "label": "Buffer",
                        "config": {"distance": 100, "distance_unit": "m"},
                    },
                },
            ],
            "edges": [
                {
                    "id": "edge-1",
                    "source": "dataset-1",
                    "target": "tool-1",
                    "targetHandle": "input_layer_id",
                }
            ],
            "viewport": {"x": 0, "y": 0, "zoom": 1},
        },
    },
}
