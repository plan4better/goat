"""GOAT Style: the layer style format, its validation, conversion and merge.

Documents are plain JSON dicts end to end; the models in `goatlib.style.models`
check them and produce the JSON Schema, and nothing rebuilds a document from a
model. See the package README for the design.
"""

from goatlib.style.context import DataContext, MapContext
from goatlib.style.issues import Fix, Issue
