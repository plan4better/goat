"""Code generation utilities for Windmill scripts.

Converts Pydantic models to Windmill-compatible function signatures.
Windmill parses function signatures statically and only understands primitive types.
"""

from enum import Enum
from typing import Literal, Union


def _is_pydantic_model(annotation: type) -> bool:
    """Check if a type is a Pydantic BaseModel."""
    try:
        from pydantic import BaseModel

        return isinstance(annotation, type) and issubclass(annotation, BaseModel)
    except (TypeError, ImportError):
        return False


def _is_enum(annotation: type) -> bool:
    """Check if a type is an Enum."""
    try:
        return isinstance(annotation, type) and issubclass(annotation, Enum)
    except TypeError:
        return False


def python_type_to_str(annotation: type) -> str:
    """Convert a Python type annotation to a string for code generation.

    Windmill only understands primitive types, so we convert:
    - Pydantic models -> dict
    - Enums/StrEnums -> str
    - list[Model] -> list[dict]
    """
    import types
    from typing import get_args, get_origin

    if annotation is type(None):
        return "None"

    # Handle Pydantic models as dict
    if _is_pydantic_model(annotation):
        return "dict"

    # Handle Enums as str (their values are strings)
    if _is_enum(annotation):
        return "str"

    origin = get_origin(annotation)

    if origin is types.UnionType or origin is Union:
        args = get_args(annotation)
        # Handle Optional (Union with None)
        non_none = [a for a in args if a is not type(None)]
        if len(non_none) == 1 and type(None) in args:
            return f"{python_type_to_str(non_none[0])} | None"
        return " | ".join(python_type_to_str(a) for a in args)

    if origin is list:
        args = get_args(annotation)
        if args:
            inner_type = python_type_to_str(args[0])
            return f"list[{inner_type}]"
        return "list"

    if origin is dict:
        return "dict"

    if origin is Literal:
        args = get_args(annotation)
        return f"Literal[{', '.join(repr(a) for a in args)}]"

    if hasattr(annotation, "__name__"):
        return annotation.__name__

    return str(annotation)


def generate_windmill_script(
    module_path: str,
    params_class: type,
    excluded_fields: set[str] | None = None,
) -> str:
    """Generate a Windmill script from a Pydantic params class.

    Windmill parses function signatures to build the JSON Schema for inputs.
    It only understands primitive types (str, int, float, bool, list, Literal, etc),
    NOT Pydantic models. So we introspect the Pydantic model fields and generate
    a function with individual typed arguments.

    Every optional argument defaults to None, and the script drops the None
    ones before it builds the model, so a setting the job leaves out reaches the
    model as absent. The model then applies its own default, including one
    it resolves from the job's other settings (a travel budget that follows
    the routing mode and cost type, as the form's `default_from` does). A
    static default in the signature would be passed on as if the job had set it.

    Args:
        module_path: Import path for the module (e.g., "goatlib.tools.buffer")
        params_class: Pydantic model class with tool parameters
        excluded_fields: Field names to skip (internal fields not exposed to users)

    Returns:
        Generated Python script content for Windmill
    """
    if excluded_fields is None:
        excluded_fields = {
            "input_path",
            "output_path",
            "overlay_path",
            "output_crs",
            "triggered_by_email",  # Injected by GeoAPI, not user-facing
            "access_token",  # Injected by processes service
            "refresh_token",  # Injected by processes service
        }

    # Get fields from Pydantic model
    fields = params_class.model_fields

    # Track if we need Literal import
    needs_literal = False

    # Build function signature - required args first, then optional
    required_args = []
    optional_args = []

    for name, field_info in fields.items():
        # Skip internal fields that aren't user-facing
        if name in excluded_fields:
            continue

        # Get type annotation
        annotation = field_info.annotation
        type_str = python_type_to_str(annotation)

        if "Literal" in type_str:
            needs_literal = True

        if field_info.is_required():
            required_args.append(f"{name}: {type_str}")
        else:
            optional = type_str if type_str.endswith("None") else f"{type_str} | None"
            optional_args.append(f"{name}: {optional} = None")

    # Required args first, then optional
    all_args = required_args + optional_args
    args_str = ",\n    ".join(all_args)
    params_class_name = params_class.__name__

    # Build imports
    imports = []
    if needs_literal:
        imports.append("from typing import Literal")

    imports_str = "\n".join(imports) if imports else ""
    imports_block = f"{imports_str}\n\n" if imports_str else ""

    # Python version directive at top - deps pre-installed in worker image
    # Use **kwargs to capture hidden fields (like _triggered_by_email) that GeoAPI
    # passes but shouldn't appear in Windmill's UI
    script = f'''# py311

{imports_block}def main(
    {args_str},
    **kwargs
) -> dict:
    """Run tool."""
    from {module_path} import {params_class_name}, main as _main

    # Merge explicit args with kwargs (for hidden fields like _triggered_by_email)
    all_args = {{k: v for k, v in locals().items() if k != "kwargs" and v is not None}}
    all_args.update({{k: v for k, v in kwargs.items() if v is not None}})
    params = {params_class_name}(**all_args)
    return _main(params)
'''
    return script
