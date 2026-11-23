"""Layer filters: OGC CQL2-JSON as saved in `layer_project.query.cql`.

`normalize` rewrites legacy and standard spellings to the form the services
evaluate (a relative day, `daysAgo(n)`, to the date it means today), `limits`
holds the limits and `measure`, `validate` checks a filter against them and
against the layer's fields, and `convert` rewrites the negations and empty
tests of filters saved before into the filter panel's form (core's data
migration runs it once). The modules are imported one by
one (`goatlib.filter.normalize`, ...): this package imports nothing, so the
services' request path and `goatlib.style.cql` load only what they use.
"""
