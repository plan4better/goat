#include "sql_export.h"

#include <cmath>
#include <duckdb.hpp>
#include <filesystem>
#include <iomanip>
#include <limits>
#include <locale>
#include <sstream>
#include <stdexcept>

namespace routing::output
{

std::string sql_escape(std::string const &s)
{
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s)
    {
        if (c == '\'')
            out += "''";
        else
            out.push_back(c);
    }
    return out;
}

std::string sql_double(double value)
{
    if (std::isnan(value))
        return "'nan'::DOUBLE";
    if (std::isinf(value))
        return value > 0 ? "'inf'::DOUBLE" : "'-inf'::DOUBLE";
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::scientific
        << std::setprecision(std::numeric_limits<double>::max_digits10 - 1) << value;
    return out.str();
}

void write_query_to_parquet(duckdb::Connection &con,
                            std::string const &copy_body,
                            std::string const &output_path,
                            std::string const &error_label)
{
    namespace fs = std::filesystem;
    fs::path out_path(output_path);
    if (!out_path.parent_path().empty())
        fs::create_directories(out_path.parent_path());

    std::ostringstream sql;
    sql << "COPY (" << copy_body << ") TO '" << sql_escape(out_path.string())
        << "' (FORMAT PARQUET, COMPRESSION ZSTD)";

    auto r = con.Query(sql.str());
    if (r->HasError())
        throw std::runtime_error(error_label + ": " + r->GetError());
}

} // namespace routing::output
