#!/usr/bin/env python3
"""Build data/stb-sg.json from the Singapore Tourism Board's attraction list.

    python3 tools/fetch_attractions.py [--if-changed]

Why this exists
---------------
OpenStreetMap knows a temple is a temple. STB's list knows it is the oldest
Hindu temple in Singapore and dates from 1827, which is the sort of thing worth
walking a hundred metres off a route for. A hundred and nine attractions, which
is nothing to ship and a real improvement to a city walk's checkpoints.

The published file is a website's content export, not a gazetteer, and it
shows. Four faults are corrected here, all of them found by looking:

* **The latitudes are rounded to three decimal places** — about a hundred and
  ten metres — while the longitudes carry five or six. Measured against
  OneMap's geocoder, the published point for the National Gallery is 83 m out
  and Sri Mariamman Temple 75 m. So each address is geocoded through OneMap's
  public search, and the answer is taken only when it agrees with the published
  point to within GEOCODE_TRUST_M; anything further apart is the geocoder
  having found a different place, and the published point stands.
* **The text is mojibake** — UTF-8 read as Windows-1252 somewhere upstream, so
  apostrophes arrive as "â€™" and "™" as "â„¢". Note cp1252 and not latin-1:
  the euro and the quote marks live in cp1252's 0x80–0x9F range, which latin-1
  has no characters for, so a latin-1 round trip raises and silently gives up
  on exactly the strings that need it.
* **The titles are written for search engines** — "Sri Mariamman Temple: Hindu
  Temple in Singapore", "Kranji War Memorial Landmark in Singapore" — and a map
  label needs the name, not the subtitle. Every rule in clean_title() below was
  written against the 109 real titles and checked against all of them.
* **The same place is listed twice** under two titles ("Marina Bay Sands®" and
  "Marina Bay Sands, Singapore"), so near-identical names within DUPLICATE_M
  are collapsed.

Dropped on purpose: the images (their domain, yoursingapore.com, no longer
resolves) and OPENING_HOURS (free-form prose, last touched in 2015 — stale
hours are worse than no hours).

Source:  "Tourist Attractions", Singapore Tourism Board, via data.gov.sg
Licence: Singapore Open Data Licence v1.0 — use permitted with attribution.
"""
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

DATASET = "d_0f2f47515425404e6c9d2a040dd87354"
POLL = f"https://api-open.data.gov.sg/v1/public/api/datasets/{DATASET}/poll-download"
META = f"https://api-production.data.gov.sg/v2/public/api/datasets/{DATASET}/metadata"
ONEMAP = "https://www.onemap.gov.sg/api/common/elastic/search"
UA = "GoWalkWalk-data-fetch/1.0 (+https://github.com/alden000/gowalkwalk)"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "data", "stb-sg.json")

# How far a geocoded point may sit from the published one and still be believed
# to be the same place. Generous enough to absorb the published latitude's
# rounding, tight enough that a geocoder landing on another street is refused.
GEOCODE_TRUST_M = 300
DUPLICATE_M = 400
OVERVIEW_CHARS = 220


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


def demojibake(text):
    """UTF-8 that was decoded as Windows-1252 upstream, put back the way round.

    The round trip only succeeds on text that really was mis-decoded; anything
    else raises and is returned untouched.
    """
    if not text or text.isascii():
        return text
    try:
        return text.encode("cp1252").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text


# Everything from the first colon, or from a dash used as punctuation, is the
# search-engine subtitle: "Haw Par Villa: Singapore Theme Park".
SUBTITLE = re.compile(r"\s*(?::|[-–—]\s+).*$")
# ", Singapore", ", a Singapore Landmark", ", Singapore Cultural District".
COMMA_SG = re.compile(r",\s*(?:an?\s+)?Singapore\b.*$", re.I)
# A trailing "Singapore" that qualifies rather than names — but not the one in
# "National Museum of Singapore", where the preposition makes it the name.
TRAIL_SG = re.compile(r"(?<!\bof)\s+Singapore$", re.I)
IN_SG = re.compile(r"\s+in\s+Singapore$", re.I)
# "& Singapore Islands", "& Museum in Singapore" — an SEO second half. A tail
# naming somewhere real ("& Mount Faber") has none of these words and stays.
GENERIC_TAIL = re.compile(
    r"\s+&\s+[^&]*\b(?:museum|park|garden|island|attraction|landmark|centre|center|"
    r"nature reserve|places of interest|things to do|culture|heritage|neighbourhood)s?\b"
    r"[^&]*$", re.I)
# "Kranji War Memorial Landmark", and lowercase SEO tails like
# "The Civilian War Memorial park".
GENERIC_END = re.compile(r"\s+(?:Landmarks?|Attractions?|park|museum|temple)$")
TRADEMARK = re.compile(r"[™®℠]")
# The words that name a category rather than a place. A title made only of
# these has been cut too far — "Singapore Garden & Singapore Park" reduces to
# "Singapore Garden", which names nowhere — so the cut is refused.
GENERIC_WORD = {
    "a", "an", "the", "and", "of", "in", "at", "on", "by", "singapore",
    "garden", "gardens", "park", "parks", "museum", "island", "islands",
    "attraction", "attractions", "landmark", "landmarks", "centre", "center",
    "culture", "heritage", "nature", "reserve", "city", "district", "tours",
}


def names_a_place(title):
    return any(w.strip(".,&()").casefold() not in GENERIC_WORD
               for w in title.split() if w.strip(".,&()"))


def clean_title(title):
    title = TRADEMARK.sub("", demojibake(title or "")).strip()
    for rule in (SUBTITLE, COMMA_SG, GENERIC_TAIL, IN_SG, GENERIC_END, TRAIL_SG):
        shorter = rule.sub("", title).strip()
        if shorter and names_a_place(shorter):
            title = shorter
    return re.sub(r"\s+", " ", title).strip()


def strip_html(text):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", demojibake(text or ""))).strip()


def haversine(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def geocode(address):
    """OneMap's public search — no key, and it knows every address in the country."""
    if not address:
        return None
    query = urllib.parse.urlencode({
        "searchVal": address, "returnGeom": "Y", "getAddrDetails": "N", "pageNum": 1})
    try:
        with urllib.request.urlopen(get(f"{ONEMAP}?{query}"), timeout=40) as r:
            results = json.load(r).get("results") or []
    except Exception:
        return None
    if not results:
        return None
    try:
        return float(results[0]["LATITUDE"]), float(results[0]["LONGITUDE"])
    except (KeyError, TypeError, ValueError):
        return None


def properties(feature):
    """Flat properties in the current export; HTML table in older ones."""
    p = feature.get("properties", {})
    desc = p.get("Description", "")
    if desc:
        return dict(zip(re.findall(r"<th>(.*?)</th>", desc), re.findall(r"<td>(.*?)</td>", desc)))
    return p


def main():
    if "--if-changed" in sys.argv:
        stamp = published_at()
        if have_already(stamp):
            print(f"unchanged: STB last published {stamp}")
            return
        print(f"STB published {stamp}; rebuilding")

    with urllib.request.urlopen(get(POLL), timeout=90) as r:
        url = json.load(r)["data"]["url"]
    with urllib.request.urlopen(get(url), timeout=300) as r:
        raw = json.load(r)

    out = []
    refined = coarse = dropped = 0
    features = raw.get("features", [])
    print(f"geocoding {len(features)} addresses through OneMap…")

    for feature in features:
        geom = feature.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if geom.get("type") != "Point" or len(coords) < 2:
            continue
        published = (float(coords[1]), float(coords[0]))
        p = properties(feature)

        name = clean_title(p.get("PAGETITLE"))
        if not name:
            continue
        address = demojibake((p.get("ADDRESS") or "").strip())

        point, precise = published, False
        found = geocode(address)
        if found and haversine(found, published) <= GEOCODE_TRUST_M:
            point, precise = found, True
            refined += 1
        else:
            coarse += 1
        time.sleep(0.25)          # a public service; ask politely

        overview = strip_html(p.get("OVERVIEW"))
        if len(overview) > OVERVIEW_CHARS:
            overview = overview[:OVERVIEW_CHARS].rsplit(" ", 1)[0] + "…"

        twin = next((o for o in out if o[2].casefold() == name.casefold()
                     and haversine((o[0], o[1]), point) <= DUPLICATE_M), None)
        if twin:
            dropped += 1
            if precise and not twin[5]:       # keep the better-placed of the two
                twin[0], twin[1], twin[5] = round(point[0], 6), round(point[1], 6), 1
            if len(overview) > len(twin[3]):
                twin[3] = overview
            continue
        out.append([round(point[0], 6), round(point[1], 6), name, overview, address,
                    1 if precise else 0])

    out.sort()
    doc = {
        "source": "Tourist Attractions, Singapore Tourism Board, via data.gov.sg",
        "datasetId": DATASET,
        "licence": "Singapore Open Data Licence v1.0",
        "attribution": "Attractions © Singapore Tourism Board, data.gov.sg; "
                       "positions refined with OneMap © Singapore Land Authority",
        "sourceUpdatedAt": published_at(),
        "bounds": {"minLat": min(a[0] for a in out), "maxLat": max(a[0] for a in out),
                   "minLon": min(a[1] for a in out), "maxLon": max(a[1] for a in out)},
        "fields": ["lat", "lon", "name", "overview", "address", "geocoded"],
        "attractions": out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
    print(f"{len(out)} attractions written to data/stb-sg.json "
          f"({os.path.getsize(OUT)/1024:.0f} KB); {refined} positions refined by OneMap, "
          f"{coarse} left as published, {dropped} duplicates merged")


if __name__ == "__main__":
    main()
