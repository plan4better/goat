#include "pt/timetable_io.h"

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <stdexcept>

#include <cista/serialization.h>

namespace routing::pt
{
    namespace
    {
        // The layout nigiri writes (cista's default mode: static version,
        // integrity hash), read without computing the hash.
        constexpr auto kMappedMode = cista::mode::WITH_STATIC_VERSION |
                                     cista::mode::SKIP_INTEGRITY |
                                     cista::mode::UNCHECKED;

        // `err` is errno as the failing call left it: read before close(),
        // which may change it.
        std::runtime_error io_error(std::string const &what,
                                    std::string const &path, int const err)
        {
            return std::runtime_error(what + " " + path + ": " +
                                      std::strerror(err));
        }
    }

    MappedTimetable::MappedTimetable(std::string const &path)
    {
        auto const fd = ::open(path.c_str(), O_RDONLY);
        if (fd == -1)
            throw io_error("cannot open timetable", path, errno);
        struct stat st{};
        if (::fstat(fd, &st) == -1)
        {
            auto const err = errno;
            ::close(fd);
            throw io_error("cannot stat timetable", path, err);
        }
        size_ = static_cast<std::size_t>(st.st_size);
        addr_ = ::mmap(nullptr, size_, PROT_READ | PROT_WRITE, MAP_PRIVATE,
                       fd, 0);
        auto const err = errno;
        ::close(fd);
        if (addr_ == MAP_FAILED)
        {
            addr_ = nullptr;
            throw io_error("cannot map timetable", path, err);
        }
        auto *const begin = static_cast<std::uint8_t *>(addr_);
        try
        {
            tt_ = cista::deserialize<nigiri::timetable, kMappedMode>(
                begin, begin + size_);
        }
        catch (...)
        {
            ::munmap(addr_, size_);
            addr_ = nullptr;
            throw;
        }
    }

    MappedTimetable::~MappedTimetable()
    {
        if (addr_ != nullptr)
            ::munmap(addr_, size_);
    }
}
