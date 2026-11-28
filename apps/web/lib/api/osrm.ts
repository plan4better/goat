/**
 * OSRM API Client for routing requests
 *
 * Features:
 * - Rate limiting (max 1 request per second)
 * - Result caching to avoid duplicate API calls
 * - Support for walking and car routing modes
 */

const OSRM_API_BASE_URL = "https://routing.openstreetmap.de";
const RATE_LIMIT_MS = 1000; // 1 request per second

// Map routing modes to OSRM profiles
const PROFILE_MAP = {
  WALK: "routed-foot",
  CAR: "routed-car",
} as const;

interface OSRMRoute {
  distance: number; // meters
  duration: number; // seconds
  geometry: string; // encoded polyline or GeoJSON depending on request
  legs: Array<{
    distance: number;
    duration: number;
    steps: Array<{
      distance: number;
      duration: number;
      geometry: string;
      name: string;
      mode: string;
    }>;
  }>;
}

interface OSRMResponse {
  code: string;
  routes: OSRMRoute[];
  waypoints: Array<{
    hint: string;
    distance: number;
    name: string;
    location: [number, number];
  }>;
}

export interface Route {
  duration: number; // seconds
  distance: number; // meters
  geometry: GeoJSON.LineString;
  legs: Array<{
    mode: string;
    duration: number;
    distance: number;
  }>;
  snappedWaypoints?: [number, number][]; // Snapped waypoint coordinates from OSRM
}

// Cache for routes to avoid duplicate requests
const routeCache = new Map<string, Route>();

// Rate limiting state
let lastRequestTime = 0;
let pendingRequest: Promise<void> | null = null;

/**
 * Generate a cache key from route parameters
 */
function getCacheKey(waypoints: [number, number][], mode: "WALK" | "CAR"): string {
  const points = waypoints.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join("|");
  return `${mode}:${points}`;
}

/**
 * Decode Google polyline to coordinates (polyline5 format)
 */
function decodePolyline(encoded: string, precision: number = 5): [number, number][] {
  const coordinates: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const factor = Math.pow(10, precision);

  while (index < encoded.length) {
    let b;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    coordinates.push([lng / factor, lat / factor]);
  }

  return coordinates;
}

/**
 * Wait for rate limit
 */
async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < RATE_LIMIT_MS) {
    const waitTime = RATE_LIMIT_MS - timeSinceLastRequest;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  lastRequestTime = Date.now();
}

/**
 * Fetch route from OSRM API
 */
async function fetchOSRMRoute(waypoints: [number, number][], mode: "WALK" | "CAR"): Promise<Route> {
  // Check cache first
  const cacheKey = getCacheKey(waypoints, mode);
  const cached = routeCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Wait for rate limit: each caller after the one before it, so callers at
  // the same moment do not both find the last request a second old.
  const turn = (pendingRequest ?? Promise.resolve()).then(waitForRateLimit);
  pendingRequest = turn;
  await turn;

  // Get the profile for this mode
  const profile = PROFILE_MAP[mode];

  // Build coordinates string: lng,lat;lng,lat;...
  const coordinatesStr = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(";");

  // Build OSRM URL: /route/v1/{profile}/{coordinates}
  const url = `${OSRM_API_BASE_URL}/${profile}/route/v1/driving/${coordinatesStr}?overview=full&geometries=polyline&steps=false&alternatives=false`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`OSRM API error: ${response.status} ${response.statusText}`);
  }

  const data: OSRMResponse = await response.json();

  if (data.code !== "Ok" || !data.routes || data.routes.length === 0) {
    throw new Error(`OSRM API error: ${data.code || "No routes found"}`);
  }

  // Get the best route (first one)
  const osrmRoute = data.routes[0];

  // Decode the geometry
  const coordinates = decodePolyline(osrmRoute.geometry);

  // Extract snapped waypoint locations from OSRM
  const snappedWaypoints = data.waypoints.map((wp) => wp.location as [number, number]);

  // Convert legs
  const legs = osrmRoute.legs.map((leg) => ({
    mode: mode.toLowerCase(),
    duration: leg.duration,
    distance: leg.distance,
  }));

  const route: Route = {
    duration: osrmRoute.duration,
    distance: osrmRoute.distance,
    geometry: {
      type: "LineString",
      coordinates,
    },
    legs,
    snappedWaypoints,
  };

  // Cache the result
  routeCache.set(cacheKey, route);

  // Clean up old cache entries (keep last 50)
  if (routeCache.size > 50) {
    const firstKey = routeCache.keys().next().value;
    routeCache.delete(firstKey);
  }

  return route;
}

/**
 * Direct route fetch without debouncing - use when you handle debouncing yourself
 */
export async function fetchRoute(waypoints: [number, number][], mode: "WALK" | "CAR"): Promise<Route> {
  return fetchOSRMRoute(waypoints, mode);
}

/**
 * Clear the route cache
 */
export function clearRouteCache(): void {
  routeCache.clear();
}

const osrmApi = {
  fetchRoute,
  clearCache: clearRouteCache,
};

export default osrmApi;
