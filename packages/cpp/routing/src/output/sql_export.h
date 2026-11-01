#pragma once

#include <string>

namespace duckdb
{
    class Connection;
}

namespace routing::output
{

// Escape single quotes so a string can be embedded in a SQL string literal.
std::string sql_escape(std::string const &s);

// A double as a SQL literal that DuckDB reads back as the same double.
// A stream's default precision (6 significant digits) and std::to_string
// (6 decimals) both round: a step size of 10/6 would be spliced as 1.66667,
// and the steps the SQL multiplies out of it would drift past the budget.
// The literal is in scientific notation with all 17 significant digits,
// which DuckDB parses as a DOUBLE. A plain decimal literal is parsed as a
// DECIMAL, and with many digits after the point its cast to DOUBLE can be
// off in the last bit. It is written in the classic locale, whatever the
// global one, so the decimal point is always a point. Infinities and NaN
// come out as 'inf'::DOUBLE, '-inf'::DOUBLE and 'nan'::DOUBLE: written bare,
// DuckDB would read them as column names.
std::string sql_double(double value);

// Write the result of a COPY body to a Parquet file using the project-standard
// options (FORMAT PARQUET, COMPRESSION ZSTD). Creates the parent directory and
// escapes the path. `copy_body` is whatever goes inside `COPY ( ... )` — a
// SELECT statement or a bare table name. On failure, throws std::runtime_error
// prefixed with `error_label`.
void write_query_to_parquet(duckdb::Connection &con,
                            std::string const &copy_body,
                            std::string const &output_path,
                            std::string const &error_label);

} // namespace routing::output
