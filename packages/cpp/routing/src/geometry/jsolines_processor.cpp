#include "jsolines_processor.h"

#include "../types.h"

#include <cmath>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <optional>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace routing::geometry {

namespace
{
static constexpr double kEarthRadius = 6378137.0;

struct PixelPos
{
	int32_t x;
	int32_t y;
};

struct PixelCoord
{
	double x;
	double y;
};

double to_longitude(double x)
{
	return x / kEarthRadius * (180.0 / M_PI);
}

double to_latitude(double y)
{
	return (2.0 * std::atan(std::exp(y / kEarthRadius)) - M_PI / 2.0) *
		   (180.0 / M_PI);
}

double ensure_fraction_is_number(double frac)
{
	if (!std::isfinite(frac))
	{
		return 0.5;
	}
	return frac;
}

std::vector<int8_t> get_contour(std::vector<double> const &surface,
								int32_t width,
								int32_t height,
								double cutoff)
{
	std::vector<int8_t> contour(static_cast<size_t>(width - 1) *
									static_cast<size_t>(height - 1),
								0);

	for (int32_t x = 0; x < width - 1; ++x)
	{
		for (int32_t y = 0; y < height - 1; ++y)
		{
			int32_t index = y * width + x;
			bool top_left = surface[index] < cutoff;
			bool top_right = surface[index + 1] < cutoff;
			bool bot_left = surface[index + width] < cutoff;
			bool bot_right = surface[index + width + 1] < cutoff;

			if (x == 0)
			{
				top_left = false;
				bot_left = false;
			}
			if (x == width - 2)
			{
				top_right = false;
				bot_right = false;
			}
			if (y == 0)
			{
				top_left = false;
				top_right = false;
			}
			if (y == height - 2)
			{
				bot_right = false;
				bot_left = false;
			}

			int8_t idx = 0;
			if (top_left)
			{
				idx |= 1 << 3;
			}
			if (top_right)
			{
				idx |= 1 << 2;
			}
			if (bot_right)
			{
				idx |= 1 << 1;
			}
			if (bot_left)
			{
				idx |= 1;
			}
			contour[static_cast<size_t>(y) * static_cast<size_t>(width - 1) +
					static_cast<size_t>(x)] = idx;
		}
	}
	return contour;
}

PixelPos follow_loop(int8_t idx, PixelPos xy, PixelPos prev_xy)
{
	int32_t x = xy.x;
	int32_t y = xy.y;
	int32_t prevx = prev_xy.x;
	int32_t prevy = prev_xy.y;

	if (idx == 1 || idx == 3 || idx == 7)
	{
		return {x - 1, y};
	}
	if (idx == 2 || idx == 6 || idx == 14)
	{
		return {x, y + 1};
	}
	if (idx == 4 || idx == 12 || idx == 13)
	{
		return {x + 1, y};
	}
	if (idx == 5)
	{
		if (prevy > y)
		{
			return {x + 1, y};
		}
		if (prevy < y)
		{
			return {x - 1, y};
		}
		return {x, y};
	}
	if (idx == 8 || idx == 9 || idx == 11)
	{
		return {x, y - 1};
	}
	if (idx == 10)
	{
		if (prevx < x)
		{
			return {x, y + 1};
		}
		if (prevx > x)
		{
			return {x, y - 1};
		}
		return {x, y};
	}
	return {x, y};
}

std::optional<PixelCoord> interpolate(PixelPos pos,
					   double cutoff,
					   PixelPos start,
					   std::vector<double> const &surface,
					   int32_t width,
					   int32_t height)
{
	int32_t x = pos.x;
	int32_t y = pos.y;
	int32_t startx = start.x;
	int32_t starty = start.y;
	int32_t index = y * width + x;

	double top_left = surface[index];
	double top_right = surface[index + 1];
	double bot_left = surface[index + width];
	double bot_right = surface[index + width + 1];

	if (x == 0)
	{
		top_left = cutoff;
		bot_left = cutoff;
	}
	if (y == 0)
	{
		top_left = cutoff;
		top_right = cutoff;
	}
	if (y == height - 2)
	{
		bot_right = cutoff;
		bot_left = cutoff;
	}
	if (x == width - 2)
	{
		top_right = cutoff;
		bot_right = cutoff;
	}

	if (startx < x)
	{
		double frac = (cutoff - top_left) / (bot_left - top_left);
		return PixelCoord{static_cast<double>(x),
				static_cast<double>(y) + ensure_fraction_is_number(frac)};
	}
	if (startx > x)
	{
		double frac = (cutoff - top_right) / (bot_right - top_right);
		return PixelCoord{static_cast<double>(x) + 1.0,
				static_cast<double>(y) + ensure_fraction_is_number(frac)};
	}
	if (starty > y)
	{
		double frac = (cutoff - bot_left) / (bot_right - bot_left);
		return PixelCoord{static_cast<double>(x) + ensure_fraction_is_number(frac),
				static_cast<double>(y) + 1.0};
	}
	if (starty < y)
	{
		double frac = (cutoff - top_left) / (top_right - top_left);
		return PixelCoord{static_cast<double>(x) + ensure_fraction_is_number(frac),
				static_cast<double>(y)};
	}

	// No move (start == pos): pathological saddle step. Signal the caller to
	// discard the ring instead of emitting a degenerate vertex.
	return std::nullopt;
}

bool point_in_polygon(Point3857 const &p, std::vector<Point3857> const &poly)
{
	if (poly.empty())
	{
		return false;
	}

	bool inside = false;
	Point3857 p1 = poly[0];
	for (size_t i = 1; i <= poly.size(); ++i)
	{
		Point3857 p2 = poly[i % poly.size()];
		if (p.y > std::min(p1.y, p2.y) &&
			p.y <= std::max(p1.y, p2.y) &&
			p.x <= std::max(p1.x, p2.x))
		{
			double xints = p1.x;
			if (p1.y != p2.y)
			{
				xints = (p.y - p1.y) * (p2.x - p1.x) / (p2.y - p1.y) + p1.x;
			}
			if (p1.x == p2.x || p.x <= xints)
			{
				inside = !inside;
			}
		}
		p1 = p2;
	}
	return inside;
}

// The unsigned area of a closed ring, in its own (degree) units: enough to
// tell which of two nested rings is the inner one.
double ring_area(std::vector<Point3857> const &ring)
{
	double twice = 0.0;
	for (size_t i = 0; i + 1 < ring.size(); ++i)
		twice += ring[i].x * ring[i + 1].y - ring[i + 1].x * ring[i].y;
	return std::abs(twice) / 2.0;
}

std::string to_multipolygon_wkt(
	std::vector<std::vector<std::vector<Point3857>>> const &polygons)
{
	std::ostringstream ss;
	ss << std::setprecision(15);
	ss << "MULTIPOLYGON(";
	for (size_t i = 0; i < polygons.size(); ++i)
	{
		if (i > 0)
		{
			ss << ",";
		}
		ss << "(";
		for (size_t r = 0; r < polygons[i].size(); ++r)
		{
			if (r > 0)
			{
				ss << ",";
			}
			ss << "(";
			for (size_t p = 0; p < polygons[i][r].size(); ++p)
			{
				if (p > 0)
				{
					ss << ",";
				}
				ss << polygons[i][r][p].x << " " << polygons[i][r][p].y;
			}
			ss << ")";
		}
		ss << ")";
	}
	ss << ")";
	return ss.str();
}
} // namespace

std::vector<JsolinesFeature> build_jsolines_wkt(
	std::vector<double> const &surface,
	int32_t width,
	int32_t height,
	double west,
	double north,
	double step_x,
	double step_y,
	std::vector<double> const &cutoffs)
{
	std::vector<JsolinesFeature> out;
	if (width < 2 || height < 2 || surface.empty())
	{
		return out;
	}

	int32_t c_width = width - 1;

	for (double cutoff : cutoffs)
	{
		auto contour = get_contour(surface, width, height, cutoff);
		std::vector<int8_t> found(static_cast<size_t>(c_width) *
									  static_cast<size_t>(height - 1),
								  0);

		std::vector<std::vector<Point3857>> shells;
		std::vector<std::vector<Point3857>> holes;

		for (int32_t origy = 0; origy < height - 1; ++origy)
		{
			for (int32_t origx = 0; origx < width - 1; ++origx)
			{
				int32_t index = origy * c_width + origx;
				if (found[index] == 1)
				{
					continue;
				}

				int8_t idx = contour[index];
				if (idx == 0 || idx == 5 || idx == 10 || idx == 15)
				{
					continue;
				}

				PixelPos pos{origx, origy};
				PixelPos prev{-1, -1};
				PixelPos start{-1, -1};
				int32_t direction = 0;
				std::vector<Point3857> ring;

				int32_t guard = static_cast<int32_t>(found.size()) + 8;
				while (guard-- > 0 && found[index] != 1)
				{
					prev = start;
					start = pos;
					idx = contour[index];

					if (idx != 5 && idx != 10)
					{
						found[index] = 1;
					}
					if (idx == 0 || idx >= 15)
					{
						break;
					}

					pos = follow_loop(idx, pos, prev);
					if (pos.x < 0 || pos.y < 0 || pos.x >= c_width ||
						pos.y >= height - 1)
					{
						break;
					}
					index = pos.y * c_width + pos.x;

					direction += (pos.x - start.x) * (pos.y + start.y);
					auto coord_opt = interpolate(pos, cutoff, start, surface, width, height);
					if (!coord_opt) break;  // no-move step: discard degenerate ring
					PixelCoord coord = *coord_opt;

					// Surface values sit at cell centres, half a cell in
					// from the grid's corner.
					double merc_x = west + (coord.x + 0.5) * step_x;
					double merc_y = north - (coord.y + 0.5) * step_y;
					// Skip zero-length segments (coincident consecutive points).
					Point3857 pt{to_longitude(merc_x), to_latitude(merc_y)};
					if (ring.empty() ||
						pt.x != ring.back().x || pt.y != ring.back().y)
						ring.push_back(pt);

					if (pos.x == origx && pos.y == origy)
					{
						if (!ring.empty())
						{
							ring.push_back(ring.front());
						}
						if (direction > 0)
						{
							shells.push_back(std::move(ring));
						}
						else
						{
							holes.push_back(std::move(ring));
						}
						break;
					}
				}
			}
		}

		std::vector<std::vector<std::vector<Point3857>>> polygons;
		polygons.reserve(shells.size());
		for (auto const &shell : shells)
		{
			if (shell.size() < 4)
			{
				continue;
			}
			polygons.push_back({shell});
		}

		for (auto const &hole : holes)
		{
			if (hole.size() < 4)
			{
				continue;
			}
			// The innermost shell around it, the smallest: a hole inside an
			// island inside another hole lies in both that island and the
			// outer shell.
			Point3857 test_pt = hole[0];
			int32_t containing = -1;
			double containing_area = 0.0;
			for (size_t i = 0; i < polygons.size(); ++i)
			{
				if (!point_in_polygon(test_pt, polygons[i][0]))
					continue;
				double const area = ring_area(polygons[i][0]);
				if (containing == -1 || area < containing_area)
				{
					containing = static_cast<int32_t>(i);
					containing_area = area;
				}
			}
			if (containing >= 0)
			{
				polygons[static_cast<size_t>(containing)].push_back(hole);
			}
		}

		if (!polygons.empty())
		{
			out.push_back({cutoff, to_multipolygon_wkt(polygons)});
		}
	}

	return out;
}

} // namespace routing::geometry
