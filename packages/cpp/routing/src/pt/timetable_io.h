#pragma once

#include <cstddef>
#include <string>

#include <nigiri/timetable.h>

namespace routing::pt
{
    // A nigiri timetable read from its .bin by memory-mapping it instead of
    // reading it whole: a request keeps resident only the pages its search
    // touches, and requests on one machine share them through the page
    // cache, which can drop them again under memory pressure.
    //
    // The mapping is private (copy-on-write): nigiri stores raw pointers as
    // offsets, and deserialising rewrites them in place, so only the pages
    // holding pointers become private copies. The file's integrity hash is
    // skipped (SKIP_INTEGRITY): checking it would read the whole file on
    // every request. The static version check stays, so a .bin written by
    // another nigiri version is refused. Files are checked once, when a
    // version is installed (the base data manifest's sha256).
    class MappedTimetable
    {
    public:
        explicit MappedTimetable(std::string const &path);
        ~MappedTimetable();

        MappedTimetable(MappedTimetable const &) = delete;
        MappedTimetable &operator=(MappedTimetable const &) = delete;

        nigiri::timetable const &operator*() const { return *tt_; }
        nigiri::timetable const *operator->() const { return tt_; }
        nigiri::timetable const *get() const { return tt_; }

    private:
        void *addr_{nullptr};
        std::size_t size_{0U};
        nigiri::timetable const *tt_{nullptr};
    };
}
