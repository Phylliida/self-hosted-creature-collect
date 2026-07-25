"""Geocode listings missing lat/lng using the local housenumbers DB, fallback Nominatim."""
import json
import re
import sqlite3
import time
import urllib.parse
import urllib.request

DB = "../data/north-america-latest.housenumbers.sqlite"
# rough Eugene/Springfield bbox (degrees)
BBOX = (43.85, 44.25, -123.40, -122.70)

SUFFIX = {
    "st": "Street", "rd": "Road", "ave": "Avenue", "av": "Avenue", "blvd": "Boulevard",
    "dr": "Drive", "ln": "Lane", "ct": "Court", "pl": "Place", "ter": "Terrace",
    "way": "Way", "pkwy": "Parkway", "hwy": "Highway", "cir": "Circle",
}
DIRS = {"n": "North", "s": "South", "e": "East", "w": "West", "ne": "Northeast", "nw": "Northwest", "se": "Southeast", "sw": "Southwest"}


def norm_street(addr):
    """'265 W 8Th Avenue' -> ('265', ['West 8th Avenue', '8th Avenue', ...])"""
    if not addr:
        return None, []
    addr = re.sub(r",.*", "", addr).strip()
    addr = re.sub(r"\s+(apt|apartment|unit|ste|suite|#)\s*[A-Za-z0-9-]+$", "", addr, flags=re.I)
    m = re.match(r"(\d+[A-Za-z\-/]*)\s+(.*)", addr)
    if not m:
        return None, []
    num, rest = m.groups()
    words = [w.lower().strip(".") for w in rest.split()]
    words = [DIRS.get(w, SUFFIX.get(w, w)) for w in words]
    name = " ".join(w.capitalize() if not w[0].isdigit() else w.lower() for w in words)
    name = re.sub(r"(\d+)(Th|St|Nd|Rd)\b", lambda m: m.group(1) + m.group(2).lower(), name)
    variants = {name}
    # no street suffix given -> try common ones ("2290 Roosevelt")
    if not any(name.endswith(" " + s) or name == s for s in set(SUFFIX.values())):
        for s in ("Boulevard", "Street", "Avenue", "Road", "Drive"):
            variants.add(name + " " + s)
    # drop directional prefix variant
    for d in DIRS.values():
        if name.startswith(d + " "):
            variants.add(name[len(d) + 1:])
        for v in list(variants):
            if v.startswith(d + " "):
                variants.add(v[len(d) + 1:])
    return num, list(variants)


def load_local(conn):
    """Load all housenumbers in the Eugene bbox via the rtree, keyed by street name."""
    lat0, lat1, lng0, lng1 = BBOX
    rows = conn.execute(
        """SELECT s.name, h.text, h.lat_u/1e6, h.lng_u/1e6
           FROM hn_rtree r
           JOIN hn h ON h.id = r.id
           JOIN streets s ON s.id = h.street_id
           WHERE r.minX >= ? AND r.maxX <= ? AND r.minY >= ? AND r.maxY <= ?""",
        (lng0, lng1, lat0, lat1),
    ).fetchall()
    by_street = {}
    for name, text, la, lo in rows:
        by_street.setdefault(name.lower(), []).append((text, la, lo))
    return by_street


def geocode_local(by_street, num, variants):
    for name in variants:
        rows = by_street.get(name.lower())
        if not rows:
            continue
        for text, la, lo in rows:
            if text == num:
                return la, lo
        try:
            target = int(re.match(r"\d+", num).group())

            def dist(r):
                m = re.match(r"\d+", r[0])
                return abs(int(m.group()) - target) if m else 1e18
            best = min(rows, key=dist)
            if dist(best) != 1e18:
                return best[1], best[2]
        except (ValueError, AttributeError):
            continue
    return None


def geocode_nominatim(addr):
    q = urllib.parse.urlencode({"q": addr + ", Eugene, OR", "format": "json", "limit": 1})
    req = urllib.request.Request(
        "https://nominatim.openstreetmap.org/search?" + q,
        headers={"User-Agent": "housing-search-student-project/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    if data:
        return float(data[0]["lat"]), float(data[0]["lon"])
    return None


if __name__ == "__main__":
    import sys
    use_nominatim = "--nominatim" in sys.argv
    listings = json.load(open("listings.json"))
    conn = sqlite3.connect(DB)
    by_street = load_local(conn)
    print(f"loaded {sum(map(len, by_street.values()))} housenumbers, {len(by_street)} streets")
    fixed = failed = 0
    for l in listings:
        if l.get("lat") and l.get("lng"):
            continue
        num, variants = norm_street(l.get("address") or "")
        got = geocode_local(by_street, num, variants) if num else None
        if not got and use_nominatim and l.get("address"):
            time.sleep(1.1)
            try:
                got = geocode_nominatim(l["address"])
            except Exception as e:
                print("nominatim err", e)
        if got:
            l["lat"], l["lng"] = got
            fixed += 1
        else:
            failed += 1
            print("FAILED:", l["address"], "|", l["title"])
        # save progress continuously
        json.dump(listings, open("listings.json", "w"), indent=1)
    print(f"geocoded={fixed} failed={failed}")
