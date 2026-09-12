"""Catalog promote-on-use, kept out of ``goatlib.tools``.

``goatlib.tools.__init__`` imports every analytics tool, which pulls the whole
geospatial stack (pyproj, gdal, geopandas, numba). ``core`` depends on goatlib
WITHOUT the ``full`` extra -- that split is what keeps its image small -- and it
calls promote on the catalog miss path, so importing it through that package
made the request fail with ModuleNotFoundError. This package's ``__init__`` is
deliberately empty: ``promote`` needs only asyncpg, duckdb and boto3.
"""
