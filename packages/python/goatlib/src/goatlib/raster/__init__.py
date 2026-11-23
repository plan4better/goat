"""Raster files read and colored on the server (the style specification's section 9).

`formula` (band formulas) and `token` (the coloring a tile URL carries) need no
raster stack, so validation can use them anywhere; `color`, `source` and `stats`
need numpy and rio-tiler (the `raster` extra) and are imported by the services
that read files (geoapi, processes).
"""
