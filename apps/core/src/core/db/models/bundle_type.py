"""The bundle type vocabulary.

No model here, and no table: a bundle's ``bundle_type`` is a ``text`` column
validated on the way in by this enum. There used to be a reference table with a
foreign key and a ``structure`` projection of the type's spec, but the
projection was written by a seeder and read by nothing — every consumer resolves
the live spec through ``goatlib.models.bundle.get_spec``, so the copy only ever
drifted. Adding a type is now a code change alone.

The enum is re-exported from here because the model modules import the
vocabulary from a model module; ``goatlib.models.bundle.SPECS`` is the source of
truth for which types exist.
"""

from goatlib.models.bundle import BundleTypeName

__all__ = ["BundleTypeName"]
