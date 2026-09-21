#!/usr/bin/env python3
"""Build data/aed-sg.json from SCDF's official public-access AED register.

    python3 tools/fetch_aed.py

Why this exists
---------------
OpenStreetMap has almost no defibrillators mapped in Singapore. Measured on a
1.2 km loop in Woodlands: OSM had none within a kilometre, SCDF's register had
161, the nearest 22 m from the path. For an app whose emergency card promises
the nearest AED, that gap is the difference between a useful answer and a
dangerously wrong one.

Why the data is vendored rather than fetched
--------------------------------------------
data.gov.sg's download API is CORS-enabled, but it answers with a signed link
to an S3 object that sends no CORS headers at all, so a browser cannot follow
it. The choice is therefore to ship the data or not to have it. Shipped, it
also works with the radio off, which is when it matters.

Source:  "Public Access AEDs", Singapore Civil Defence Force, via data.gov.sg
Licence: Singapore Open Data Licence v1.0 — use permitted with attribution.
Re-run this when SCDF publish an update (roughly yearly).
"""
import json
import os
import re
import sys
import time
import urllib.request

DATASET = "d_4e6b82c58a8a832f6f1fee5dfa6d47ea"
# data.gov.sg refuses urllib's default User-Agent with a 403. A descriptive one
# that says who is asking and why is both accepted and the polite thing to send.
UA = "GoWalkWalk-data-fetch/1.0 (+https://github.com/alden000/gowalkwalk)"
POLL = f"https://api-open.data.gov.sg/v1/public/api/datasets/{DATASET}/poll-download"
META = f"https://api-production.data.gov.sg/v2/public/api/datasets/{DATASET}/metadata"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "data", "aed-sg.json")

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
# JavaScript's Date#getDay(): Sunday is 0. The schedules are written in that
# order so the app can index them with getDay() and no arithmetic.
JS_INDEX = {"Sun": 0, "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6}

SEGMENT = re.compile(
    r"(?P<from>Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*(?:-\s*(?P<to>Mon|Tue|Wed|Thu|Fri|Sat|Sun))?\s*"
    r"(?:(?P<closed>Closed)|(?P<o1>\d{1,2}):(?P<o2>\d{2})\s*-\s*(?P<c1>\d{1,2}):(?P<c2>\d{2}))",
    re.I)


def get(url):
    return urllib.request.Request(url, headers={"User-Agent": UA})


def parse_hours(text):
    """"Mon - Fri 08:30-18:00; Sat 08:30-13:00; Sun Closed;" → 7 day windows.

    Each day is [openMinute, closeMinute] or null for closed. A close at 23:59
    is normalised to 1440 so "open all day" compares cleanly; a close earlier
    than its open runs past midnight and is kept as given, for the app to read
    as a wrap.
    """
    week = [None] * 7
    seen = False
    for m in SEGMENT.finditer(text or ""):
        seen = True
        start = m.group("from").title()
        end = (m.group("to") or start).title()
        i = DAYS.index(start)
        span = []
        while True:
            span.append(DAYS[i])
            if DAYS[i] == end:
                break
            i = (i + 1) % 7
            if len(span) > 7:
                break
        if m.group("closed"):
            window = None
        else:
            o = int(m.group("o1")) * 60 + int(m.group("o2"))
            c = int(m.group("c1")) * 60 + int(m.group("c2"))
            if c == 23 * 60 + 59:
                c = 1440
            window = [o, c]
        for day in span:
            week[JS_INDEX[day]] = window
    # Nothing parseable: treat as unknown rather than closed. An AED wrongly
    # called closed is one a walker will not go to.
    return week if seen else "?"


def published_at():
    """When SCDF last updated the register, from the metadata alone.

    A few hundred bytes, against seven megabytes for the register itself. This
    is what makes a daily check reasonable: the answer is almost always "no
    change", and finding that out should not cost a download.
    """
    with urllib.request.urlopen(get(META), timeout=60) as r:
        return json.load(r)["data"].get("lastUpdatedAt", "")


def have_already(stamp):
    try:
        with open(OUT, encoding="utf-8") as f:
            return json.load(f).get("sourceUpdatedAt") == stamp and bool(stamp)
    except (OSError, ValueError):
        return False


def main():
    # --if-changed: for the scheduled job. Ask what SCDF have published, and
    # stop without touching anything when it is what we already shipped.
    if "--if-changed" in sys.argv:
        stamp = published_at()
        if have_already(stamp):
            print(f"unchanged: SCDF last published {stamp} and that is what data/aed-sg.json holds")
            return
        print(f"SCDF published {stamp}; rebuilding")

    print("asking data.gov.sg for a download link…")
    with urllib.request.urlopen(get(POLL), timeout=90) as r:
        url = json.load(r)["data"]["url"]
    print("downloading the register…")
    with urllib.request.urlopen(get(url), timeout=300) as r:
        raw = json.load(r)

    # Only 132 distinct opening-hours strings cover all 9,644 AEDs, so they are
    # stored once and referenced by index: the parsed schedule and the original
    # wording both come along for a tenth of the bytes.
    hours_index = {}
    hours_text = []
    schedules = []
    out = []
    skipped = 0

    for feat in raw.get("features", []):
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if geom.get("type") != "Point" or len(coords) < 2:
            skipped += 1
            continue
        lon, lat = float(coords[0]), float(coords[1])
        p = feat.get("properties", {})

        text = (p.get("OPERATING_HOURS") or "").strip()
        if text not in hours_index:
            hours_index[text] = len(hours_text)
            hours_text.append(text)
            schedules.append(parse_hours(text))
        hi = hours_index[text]

        # Half the register is HDB blocks with no building name; "694E Woodlands
        # Drive 62" is what a walker would say out loud, so it is composed here
        # rather than leaving the pin unnamed.
        name = (p.get("BUILDING_NAME") or "").strip()
        house = (p.get("HOUSE_NUMBER") or "").strip()
        road = (p.get("ROAD_NAME") or "").strip()
        if not name:
            name = " ".join(x for x in (house, road) if x)
        where = (p.get("AED_LOCATION_DESCRIPTION") or "").strip()
        floor = (p.get("AED_LOCATION_FLOOR_LEVEL") or "").strip()

        out.append([
            round(lat, 6), round(lon, 6), hi, name, where, floor,
        ])

    out.sort(key=lambda r: (r[0], r[1]))
    doc = {
        "source": "Public Access AEDs, Singapore Civil Defence Force, via data.gov.sg",
        "datasetId": DATASET,
        # SCDF's own publication stamp, so a scheduled check can tell "they have
        # published something new" from "we happen to have run again today".
        "sourceUpdatedAt": published_at(),
        "licence": "Singapore Open Data Licence v1.0",
        "attribution": "AED locations © Singapore Civil Defence Force, data.gov.sg",
        "fetchedAt": time.strftime("%Y-%m-%d"),
        "fields": ["lat", "lon", "hoursIndex", "name", "where", "floor"],
        "hoursText": hours_text,
        "hoursWeek": schedules,
        "aed": out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)

    always = sum(1 for s in schedules if s != "?" and all(w == [0, 1440] for w in s))
    print(f"{len(out):,} AEDs written to data/aed-sg.json "
          f"({os.path.getsize(OUT)/1024:.0f} KB, {skipped} skipped)")
    print(f"{len(hours_text)} distinct opening-hours strings, {always} of them 24/7")


if __name__ == "__main__":
    main()
