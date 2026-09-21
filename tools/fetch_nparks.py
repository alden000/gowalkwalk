#!/usr/bin/env python3
"""Build data/nparks-sg.json from NParks' own amenity register.

    python3 tools/fetch_nparks.py [--if-changed]

Why this exists
---------------
OpenStreetMap is thin exactly where a hiking app most needs to be thick. A probe
of the MacRitchie corridor returned eight tagged elements in total; NParks'
register has 449 points across the same reserves, including ninety-six shelters
and huts by name — Chemperai Hut, Drongo Hut, Bangkit Shelter — eighteen
toilets, the car parks, the observation towers and the wartime remains. Those
are the things a walker in the Central Catchment actually looks for.

The register uses a numeric BUILD_TYPE with no published key, so the mapping
below was read off the data: every code's points were listed with their names
and identified from those. It is recorded here because a number in a file is
not self-explanatory and the next person should not have to do it again.

Source:  "Central Nature Reserve Amenities", National Parks Board, data.gov.sg
Licence: Singapore Open Data Licence v1.0 — use permitted with attribution.
"""
import json
import os
import re
import sys
import urllib.request

DATASET = "d_19a87bbb86b2c14601a1745076812438"
POLL = f"https://api-open.data.gov.sg/v1/public/api/datasets/{DATASET}/poll-download"
META = f"https://api-production.data.gov.sg/v2/public/api/datasets/{DATASET}/metadata"
UA = "GoWalkWalk-data-fetch/1.0 (+https://github.com/alden000/gowalkwalk)"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "data", "nparks-sg.json")

# BUILD_TYPE, read off the register itself. Anything not listed is left out:
# type 1 is signage and entrances (116 of its 122 points unnamed), 7 is
# artwork, 8 is a hundred unnamed points of unknown purpose, 11 is playgrounds
# and fitness corners, and 12 is distance markers — none of which is a facility
# this app plots or a landmark worth sending anyone to.
FACILITY_TYPE = {
    2: "shelter",     # 96: huts and shelters, by name
    4: "toilet",      # 18
    5: "parking",     # 27, including bicycle parking — filtered out below
}
# Towers and wartime remains: the things a walker would actually detour for.
LANDMARK_TYPE = {
    3: ("Tower", 8),          # Jelutong Tower, Canopy Bridge Tower
    9: ("Historic site", 8),  # Machine Gun Post, WWII Memorial, Cannon
}
# Type 6 is a mixed bag of buildings: the visitor-facing ones are worth having,
# the site offices and the radio station are not.
VISITOR_BUILDING = re.compile(r"visitor centre|ranger station|education centre|chestnut point", re.I)
PAVILION = re.compile(r"pavilion", re.I)

FALLBACK = {"shelter": "Shelter", "toilet": "Toilet", "parking": "Car park"}


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


def properties(feature):
    """Attributes, however this export happens to carry them."""
    p = feature.get("properties", {})
    desc = p.get("Description", "")
    if desc:
        return dict(zip(re.findall(r"<th>(.*?)</th>", desc), re.findall(r"<td>(.*?)</td>", desc)))
    return p


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

    places, landmarks = [], []
    lats, lons = [], []
    for feature in raw.get("features", []):
        geom = feature.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if geom.get("type") != "Point" or len(coords) < 2:
            continue
        lon, lat = round(float(coords[0]), 6), round(float(coords[1]), 6)
        lats.append(lat)
        lons.append(lon)

        p = properties(feature)
        try:
            build = int(p.get("BUILD_TYPE"))
        except (TypeError, ValueError):
            continue
        name = (p.get("BUILD_NAME") or "").strip()

        cat = FACILITY_TYPE.get(build)
        if cat == "parking" and "bicycle" in name.lower():
            continue                      # a bike rack is not somewhere to leave a car
        if build == 6:
            if PAVILION.search(name):
                cat = "shelter"
            elif VISITOR_BUILDING.search(name):
                landmarks.append([lat, lon, 6, name, "Visitor building"])
                continue
            else:
                continue
        if cat:
            places.append([lat, lon, cat, name or FALLBACK[cat], ""])
            continue

        kind = LANDMARK_TYPE.get(build)
        if kind:
            label, rank = kind
            landmarks.append([lat, lon, rank, name or label, label])

    doc = {
        "source": "Central Nature Reserve Amenities, National Parks Board, via data.gov.sg",
        "datasetId": DATASET,
        "licence": "Singapore Open Data Licence v1.0",
        "attribution": "Park amenities © National Parks Board, data.gov.sg",
        "sourceUpdatedAt": published_at(),
        # The register covers the central reserves and the southern ridges, not
        # the whole country, so the app only consults it for a route that is
        # actually inside the ground it describes.
        "bounds": {"minLat": min(lats), "maxLat": max(lats),
                   "minLon": min(lons), "maxLon": max(lons)},
        "placeFields": ["lat", "lon", "category", "name", "detail"],
        "landmarkFields": ["lat", "lon", "rank", "name", "kind"],
        "places": sorted(places),
        "landmarks": sorted(landmarks),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)

    counts = {}
    for _, _, cat, _, _ in places:
        counts[cat] = counts.get(cat, 0) + 1
    print(f"{len(places)} facilities {counts} and {len(landmarks)} landmarks "
          f"written to data/nparks-sg.json ({os.path.getsize(OUT)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
