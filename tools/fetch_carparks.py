#!/usr/bin/env python3
"""Build data/carparks-sg.json from HDB's register of its car parks.

    python3 tools/fetch_carparks.py [--if-changed]
    python3 tools/fetch_carparks.py --verify     # check the projection only

Why this exists
---------------
This is half of a pair. HDB publishes *where* its 2,272 car parks are, once a
month, and separately publishes *how full they are* once a minute. The
positions ship with the app, because they barely change and a walker deciding
where to leave the car should not have to wait for a download. The occupancy is
fetched live, by the app, only when somebody asks for it — see js/carparks.js.

The one hard part is the coordinates. The register gives them in SVY21
(EPSG:3414), Singapore's own grid, in metres from a point near Bukit Timah —
`x_coord: 30314.7936`. A web map needs degrees. OneMap has a converter but it
needs an API token, so the transverse Mercator inverse is done here, and then
*checked against the authority*: OneMap's public search returns both X/Y and
latitude/longitude for the same point, which is exact paired ground truth.
Against 106 such pairs spread from Tuas to Changi, with the origin at exactly
1°22'N 103°50'E:

    93 of 106 agree to under a centimetre
     5 to within 10 cm
     5 to within a metre
     3 within 1.8 m — OneMap records whose own two coordinates disagree

Run `--verify` to reproduce that. The truncated origin 1.366666/103.833333 that
a lot of code on the internet uses instead leaves a constant 8.3 cm offset; it
would not matter for a map pin, but being exactly right costs nothing.

Source:  "HDB Carpark Information", Housing & Development Board, via data.gov.sg
Licence: Singapore Open Data Licence v1.0 — use permitted with attribution.
"""
import csv
import io
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request

DATASET = "d_23f946fa557947f93a8043bbef41dd09"
POLL = f"https://api-open.data.gov.sg/v1/public/api/datasets/{DATASET}/poll-download"
META = f"https://api-production.data.gov.sg/v2/public/api/datasets/{DATASET}/metadata"
ONEMAP = "https://www.onemap.gov.sg/api/common/elastic/search"
# The live feed the app calls for itself. Recorded here so the two halves of
# the pair are described in one place; nothing in this script fetches it.
LIVE = "https://api.data.gov.sg/v1/transport/carpark-availability"
UA = "GoWalkWalk-data-fetch/1.0 (+https://github.com/alden000/gowalkwalk)"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "data", "carparks-sg.json")

# ── SVY21 (EPSG:3414) → WGS84 ────────────────────────────────────────────
# Transverse Mercator on the WGS84 ellipsoid. The origin is 1°22'N 103°50'E
# exactly; see the module docstring for why that last digit is worth having.
A = 6378137.0
F = 1 / 298.257223563
ORIGIN_LAT, ORIGIN_LON = 1 + 22 / 60, 103 + 50 / 60
FALSE_N, FALSE_E = 38744.572, 28001.642
K = 1.0

B = A * (1 - F)
E2 = 2 * F - F * F
E4, E6 = E2 * E2, E2 * E2 * E2
A0 = 1 - E2 / 4 - 3 * E4 / 64 - 5 * E6 / 256
A2 = (3 / 8) * (E2 + E4 / 4 + 15 * E6 / 128)
A4 = (15 / 256) * (E4 + 3 * E6 / 4)
A6 = 35 * E6 / 3072


def meridian_arc(lat):
    return A * (A0 * lat - A2 * math.sin(2 * lat)
                + A4 * math.sin(4 * lat) - A6 * math.sin(6 * lat))


def svy21_to_wgs84(easting, northing):
    n = (A - B) / (A + B)
    n2, n3, n4 = n * n, n ** 3, n ** 4
    g = A * (1 - n) * (1 - n2) * (1 + 9 * n2 / 4 + 225 * n4 / 64) * (math.pi / 180)
    m_prime = meridian_arc(math.radians(ORIGIN_LAT)) + (northing - FALSE_N) / K
    sigma = (m_prime * math.pi) / (180.0 * g)

    # the footpoint latitude: where the northing would land on the meridian
    lat_p = (sigma
             + (3 * n / 2 - 27 * n3 / 32) * math.sin(2 * sigma)
             + (21 * n2 / 16 - 55 * n4 / 32) * math.sin(4 * sigma)
             + (151 * n3 / 96) * math.sin(6 * sigma)
             + (1097 * n4 / 512) * math.sin(8 * sigma))

    s2 = math.sin(lat_p) ** 2
    rho = A * (1 - E2) / pow(1 - E2 * s2, 1.5)      # meridional radius
    v = A / math.sqrt(1 - E2 * s2)                  # prime vertical radius
    psi = v / rho
    psi2, psi3, psi4 = psi ** 2, psi ** 3, psi ** 4
    t = math.tan(lat_p)
    t2, t4, t6 = t ** 2, t ** 4, t ** 6
    e_prime = easting - FALSE_E
    x = e_prime / (K * v)
    x3, x5, x7 = x ** 3, x ** 5, x ** 7

    base = t / (K * rho)
    lat = (lat_p
           - base * (x * e_prime / 2)
           + base * ((x3 * e_prime) / 24) * (-4 * psi2 + 9 * psi * (1 - t2) + 12 * t2)
           - base * ((x5 * e_prime) / 720) * (8 * psi4 * (11 - 24 * t2)
                                              - 12 * psi3 * (21 - 71 * t2)
                                              + 15 * psi2 * (15 - 98 * t2 + 15 * t4)
                                              + 180 * psi * (5 * t2 - 3 * t4) + 360 * t4)
           + base * ((x7 * e_prime) / 40320) * (1385 + 3633 * t2 + 4095 * t4 + 1575 * t6))

    sec = 1 / math.cos(lat_p)
    lon = (math.radians(ORIGIN_LON)
           + x * sec
           - ((x3 * sec) / 6) * (psi + 2 * t2)
           + ((x5 * sec) / 120) * (-4 * psi3 * (1 - 6 * t2) + psi2 * (9 - 68 * t2)
                                   + 72 * psi * t2 + 24 * t4)
           - ((x7 * sec) / 5040) * (61 + 662 * t2 + 1320 * t4 + 720 * t6))
    return math.degrees(lat), math.degrees(lon)


# ── the register's vocabularies, as published ────────────────────────────
CAR_PARK_TYPE = {
    "MULTI-STOREY CAR PARK": "Multi-storey",
    "SURFACE CAR PARK": "Surface",
    "BASEMENT CAR PARK": "Basement",
    "SURFACE/MULTI-STOREY CAR PARK": "Surface and multi-storey",
    "COVERED CAR PARK": "Covered",
    "MECHANISED AND SURFACE CAR PARK": "Mechanised and surface",
    "MECHANISED CAR PARK": "Mechanised",
}
FREE_PARKING = {
    "NO": "",
    "SUN & PH FR 7AM-10.30PM": "Free Sun and public holidays, 7am–10.30pm",
    "SUN & PH FR 1PM-10.30PM": "Free Sun and public holidays, 1pm–10.30pm",
}
# The address already ends in the car park type for thirty-two of them — either
# spelled out or as HDB's own "MSCP" — and the type has a field of its own.
TYPE_TAIL = re.compile(
    r"\s*(?:(?:BASEMENT|SURFACE|MULTI-STOREY|COVERED|MECHANISED)?\s*CAR\s*PARK|MSCP)\s*$", re.I)


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


def readable(address):
    """SHOUTED ADDRESSES into something a walker reads without squinting.

    Word by word rather than str.title(), which capitalises the letter after an
    apostrophe — "QUEEN'S" becomes "Queen'S". Anything with a digit or a
    bracket in it is left exactly as published, because "213-215,218-227" and
    "(LUB)" are not words and title case only damages them.
    """
    words = []
    for word in TYPE_TAIL.sub("", address or "").split():
        words.append(word if re.search(r"[\d()]", word) else word[:1] + word[1:].lower())
    return " ".join(words)


def haversine(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def verify():
    """Check the projection against OneMap, which publishes both coordinates."""
    places = ["ALBERT CENTRE", "CHANGI AIRPORT", "TUAS SOUTH", "WOODLANDS", "JURONG POINT",
              "SENTOSA", "PUNGGOL", "MARINA BAY", "BUKIT TIMAH", "PASIR RIS",
              "LIM CHU KANG", "CHANGI VILLAGE"]
    errors = []
    for place in places:
        query = urllib.parse.urlencode(
            {"searchVal": place, "returnGeom": "Y", "getAddrDetails": "N", "pageNum": 1})
        try:
            with urllib.request.urlopen(get(f"{ONEMAP}?{query}"), timeout=40) as r:
                results = json.load(r).get("results") or []
        except Exception as err:
            print(f"  {place}: {err}")
            continue
        for found in results:
            try:
                x, y = float(found["X"]), float(found["Y"])
                lat, lon = float(found["LATITUDE"]), float(found["LONGITUDE"])
            except (KeyError, TypeError, ValueError):
                continue
            errors.append(haversine(svy21_to_wgs84(x, y), (lat, lon)) * 100)
    if not errors:
        print("no pairs returned; OneMap unreachable?")
        return 1
    errors.sort()
    buckets = [sum(1 for e in errors if e < 1), sum(1 for e in errors if 1 <= e < 10),
               sum(1 for e in errors if 10 <= e < 100), sum(1 for e in errors if e >= 100)]
    print(f"{len(errors)} paired points from OneMap: "
          f"{buckets[0]} under 1 cm, {buckets[1]} under 10 cm, "
          f"{buckets[2]} under 1 m, {buckets[3]} over 1 m (worst {errors[-1]/100:.2f} m)")
    return 0 if errors[len(errors) // 2] < 1 else 1


def main():
    if "--verify" in sys.argv:
        sys.exit(verify())

    if "--if-changed" in sys.argv:
        stamp = published_at()
        if have_already(stamp):
            print(f"unchanged: HDB last published {stamp}")
            return
        print(f"HDB published {stamp}; rebuilding")

    with urllib.request.urlopen(get(POLL), timeout=90) as r:
        url = json.load(r)["data"]["url"]
    with urllib.request.urlopen(get(url), timeout=300) as r:
        rows = list(csv.DictReader(io.StringIO(r.read().decode("utf-8-sig"))))

    out, lats, lons = [], [], []
    skipped = 0
    for row in rows:
        try:
            lat, lon = svy21_to_wgs84(float(row["x_coord"]), float(row["y_coord"]))
        except (KeyError, TypeError, ValueError):
            skipped += 1
            continue
        # Singapore, generously. A coordinate outside this is a bad row, not a
        # car park, and a pin in the sea helps nobody.
        if not (1.15 < lat < 1.50 and 103.55 < lon < 104.15):
            skipped += 1
            continue
        number = (row.get("car_park_no") or "").strip()
        if not number:
            skipped += 1
            continue
        lats.append(lat)
        lons.append(lon)
        out.append([
            number,
            round(lat, 6),
            round(lon, 6),
            readable(row.get("address")),
            CAR_PARK_TYPE.get((row.get("car_park_type") or "").strip(), ""),
            FREE_PARKING.get((row.get("free_parking") or "").strip(), ""),
            1 if (row.get("night_parking") or "").strip() == "YES" else 0,
        ])

    out.sort()
    doc = {
        "source": "HDB Carpark Information, Housing & Development Board, via data.gov.sg",
        "datasetId": DATASET,
        "licence": "Singapore Open Data Licence v1.0",
        "attribution": "Car parks and live availability © Housing & Development Board, "
                       "via data.gov.sg",
        "sourceUpdatedAt": published_at(),
        "live": LIVE,
        "bounds": {"minLat": min(lats), "maxLat": max(lats),
                   "minLon": min(lons), "maxLon": max(lons)},
        "fields": ["no", "lat", "lon", "address", "type", "free", "night"],
        "carparks": out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
    print(f"{len(out)} car parks written to data/carparks-sg.json "
          f"({os.path.getsize(OUT)/1024:.0f} KB); {skipped} rows skipped")


if __name__ == "__main__":
    main()
