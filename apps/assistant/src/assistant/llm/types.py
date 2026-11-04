"""Names shared by the settings and the model layer (spec §4.2, §4.7)."""

from typing import Literal

ProviderType = Literal[
    "anthropic",
    "bedrock",
    "vertex",
    "azure_openai",
    "openai",
    "mistral",
    "openai_compatible",
]

PROVIDER_TYPES: tuple[ProviderType, ...] = (
    "anthropic",
    "bedrock",
    "vertex",
    "azure_openai",
    "openai",
    "mistral",
    "openai_compatible",
)

#: GOAT AI's provider: one of the types, ``none`` (no built-in connection) or
#: ``test`` (Pydantic AI's test models, for tests and local development).
DefaultProvider = Literal[
    "none",
    "test",
    "anthropic",
    "bedrock",
    "vertex",
    "azure_openai",
    "openai",
    "mistral",
    "openai_compatible",
]

DataPolicy = Literal["standard", "restricted"]
