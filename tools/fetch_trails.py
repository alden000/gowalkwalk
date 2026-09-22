#!/usr/bin/env python3
"""Build data/trails-sg.json from NParks' own map of the reserve trails.

    python3 tools/fetch_trails.py [--if-changed]

Why this exists
---------------
Not for coverage. Measured against OpenStreetMap over the same box across the
Central Catchment (1.335–1.395 N, 103.785–103.835 E), on the day this was
written:

    OpenStreetMap   1,746 ways   263.2 km   49 distinct names
    NParks            119 ways    82.0 km   51 distinct names

and 72% of NParks' vertices already have an OpenStreetMap node within 15 m. So
the crowd has mapped this ground thoroughly, and swapping one source for the
other would lose a hundred and eighty kilometres of real path. This register is
worth shipping for two other reasons.

**It is instant, and it works with the radio off.** The probe above is what the
app's own trails overlay costs today: 172 seconds from the mirror that answered
and a 504 after 197 seconds from the one that did not. That is the slowest thing
the app does, and it is asked for at the worst possible moment — by somebody
already in the forest, on one bar, wondering which of two paths to take. 150 KB
shipped with the app answers that in no time at all and with no network.

**It carries the numbers on the signs.** MacRitchie is walked by route number —
the signs say "Route 3" — and OpenStreetMap has none of the six. NParks does.

Two things are read off the data rather than assumed:

* **TRAIL_TYPE is undocumented** and is left undecoded, because guessing at it
  would put a claim on the map that nothing supports. What is visible is that
  types 11–26 are small and wholly named while 0–10 carry all 379 unnamed
  segments, and that types 21–26 each contain exactly one segment named "MNT
  Route 1" … "MNT Route 6". So a group whose members include a route name lends
  that name to the rest of the group — read off the group, not inferred from
  the number.
* **The names are a surveyor's shorthand** — "Bt Peirce Track", "LP Resr Pk
  Track", "Jln Belang" — which is not what a walker reads on a signpost. They
  are expanded from the table below, which was written against all 87 real
  names and checked against all of them.

Source:  "Central Nature Reserve Hiking Trails", National Parks Board,
         via data.gov.sg
Licence: Singapore Open Data Licence v1.0 — use permitted with attribution.
"""
import json
import math
import os
import re
import sys
import urllib.request

DATASET = "d_84e6db6c43ffb8b17803334ec2b5c95d"
POLL = f"https://api-open.data.gov.sg/v1/public/api/datasets/{DATASET}/poll-download"
META = f"https://api-production.data.gov.sg/v2/public/api/datasets/{DATASET}/metadata"
UA = "GoWalkWalk-data-fetch/1.0 (+https://github.com/alden000/gowalkwalk)"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "data", "trails-sg.json")

# How far a simplified line may stray from the surveyed one.
#
# One metre, because the app's map reaches zoom 19, where a pixel is 0.30 m on
# the ground — so this is three pixels at the deepest zoom anyone can get to,
# and less than that everywhere else. It is also the precision the app already
# stores OpenStreetMap trails at (five decimal places, 1.1 m), so the two
# sources are drawn to the same standard. It takes 13,422 surveyed vertices
# down to 7,544 and the file from 267 KB to 153 KB.
SIMPLIFY_M = 1.0

# Surveyor's shorthand → what a signpost says. Applied on word boundaries, so
# "Bt" in "Bt Peirce" expands and a "bt" inside a word does not.
EXPAND = [
    (r"\bMNT\b", "MacRitchie Nature Trail"),
    (r"\bTTW\b", "TreeTop Walk"),
    (r"\bMR\b", "MacRitchie"),
    (r"\bLP\b", "Lower Peirce"),
    (r"\bBt\b", "Bukit"),
    (r"\bJln\b", "Jalan"),
    (r"\bLor\b", "Lorong"),
    (r"\bResr\b", "Reservoir"),
    (r"\bPk\b", "Park"),
    (r"\bPCN\b", "Park Connector"),
    (r"\bRd\b", "Road"),
    (r"\bAve\b", "Avenue"),
]
# The register spells the same hill both ways; the map and the signs use two Ls.
EXPAND.append((r"\bBukit Kalang\b", "Bukit Kallang"))

ROUTE_NAME = re.compile(r"^(?:MacRitchie Nature Trail|MNT )?\s*Route \d+$", re.I)
STEPS = re.compile(r"\bstep|\bstair", re.I)


def get(url):
    return urllib.request.Request(url, headers={"User-Agent": UA})


def published_at():
    with urllib.request.urlopen(get(META), timeout=60) as r:
        return json.load(r)["data"].get("lastUpdatedAt", "")


def have_already(stamp):
    try:
        with open(OUT, encoding="utf-8") as f:
            return json.load(f).get("sourceUpdatedAt") == stamp and bool(stamp)
    except (OSError, ValueError):
        return False


def expand(name):
    name = re.sub(r"\s+", " ", (name or "").strip())
    for pattern, full in EXPAND:
        name = re.sub(pattern, full, name)
    return name.strip(" ,")


def parts(geometry):
    """Both geometry types the register uses, as plain coordinate lists."""
    kind = geometry.get("type")
    if kind == "LineString":
        return [geometry.get("coordinates") or []]
    if kind == "MultiLineString":
        return geometry.get("coordinates") or []
    return []


def offset(point, start, end):
    """Metres from `point` to the segment start→end, flat-earth locally.

    Points are (lat, lon), so latitude is the northing and longitude the
    easting — and the easting shrinks by cos(latitude), not by cos(longitude).
    Getting that the wrong way round costs nothing visible: it still simplifies,
    just against a scale that is negative in the eastern hemisphere, and throws
    away a third more vertices than it should.
    """
    kx = math.cos(math.radians(start[0])) * 111320      # metres per degree east
    ky = 110540                                          # metres per degree north
    py, px = (point[0] - start[0]) * ky, (point[1] - start[1]) * kx
    by, bx = (end[0] - start[0]) * ky, (end[1] - start[1]) * kx
    length = bx * bx + by * by
    if length == 0:
        return math.hypot(px, py)
    t = max(0.0, min(1.0, (px * bx + py * by) / length))
    return math.hypot(px - t * bx, py - t * by)


def simplify(points, eps):
    """Ramer–Douglas–Peucker, iteratively: a 700-point line overflows the stack."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        lo, hi = stack.pop()
        worst, at = eps, -1
        for i in range(lo + 1, hi):
            d = offset(points[i], points[lo], points[hi])
            if d > worst:
                worst, at = d, i
        if at >= 0:
            keep[at] = True
            stack.append((lo, at))
            stack.append((at, hi))
    return [p for p, k in zip(points, keep) if k]


def haversine(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def main():
    if "--if-changed" in sys.argv:
        stamp = published_at()
        if have_already(stamp):
            print(f"unchanged: NParks last published {stamp}")
            return
        print(f"NParks published {stamp}; rebuilding")

    with urllib.request.urlopen(get(POLL), timeout=90) as r:
        url = json.load(r)["data"]["url"]
    with urllib.request.urlopen(get(url), timeout=300) as r:
        raw = json.load(r)

    features = raw.get("features", [])

    # A group whose members include a route name lends it to the whole group.
    route_of = {}
    for feature in features:
        p = feature.get("properties", {})
        name = expand(p.get("TRAIL_NAME"))
        if ROUTE_NAME.match(name):
            route_of[p.get("TRAIL_TYPE")] = name

    ways, surveyed, kept = [], 0, 0
    lats, lons = [], []
    for feature in features:
        p = feature.get("properties", {})
        name = expand(p.get("TRAIL_NAME"))
        route = route_of.get(p.get("TRAIL_TYPE"), "")
        if route == name:
            route = ""                    # the segment is the route itself
        for line in parts(feature.get("geometry") or {}):
            points = [(c[1], c[0]) for c in line if len(c) >= 2]
            surveyed += len(points)
            points = simplify(points, SIMPLIFY_M)
            if len(points) < 2:
                continue
            kept += len(points)
            lats.extend(p_[0] for p_ in points)
            lons.extend(p_[1] for p_ in points)
            ways.append([
                name,
                route,
                1 if STEPS.search(name) else 0,
                [[round(lat, 5), round(lon, 5)] for lat, lon in points],
            ])

    doc = {
        "source": "Central Nature Reserve Hiking Trails, National Parks Board, "
                  "via data.gov.sg",
        "datasetId": DATASET,
        "licence": "Singapore Open Data Licence v1.0",
        "attribution": "Trails © National Parks Board, data.gov.sg",
        "sourceUpdatedAt": published_at(),
        "bounds": {"minLat": min(lats), "maxLat": max(lats),
                   "minLon": min(lons), "maxLon": max(lons)},
        "fields": ["name", "route", "steps", "pts"],
        "ways": ways,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)

    named = sum(1 for w in ways if w[0])
    routed = sum(1 for w in ways if w[1])
    total = sum(
        sum(haversine(w[3][i], w[3][i + 1]) for i in range(len(w[3]) - 1)) for w in ways)
    print(f"{len(ways)} lines written to data/trails-sg.json "
          f"({os.path.getsize(OUT)/1024:.0f} KB); {total/1000:.1f} km, "
          f"{named} named, {routed} carrying a route number; "
          f"{surveyed} surveyed vertices simplified to {kept} at {SIMPLIFY_M} m")


if __name__ == "__main__":
    main()
