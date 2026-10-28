"""Pydantic models of the GOAT Style reference (the specification's section 18).

They check structure and produce the JSON Schema. Documents are never rebuilt
from them: callers keep the dict they validated.
"""
