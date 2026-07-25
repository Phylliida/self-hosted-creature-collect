"""Parse scraped HTML into listings.json (source, title, price, beds, address, lat, lng, url)."""
import json
import re
import html as htmlmod


def parse_price(s):
    """'$1,340+' or '$1,200 - $1,500' -> (min, max)"""
    nums = [int(x.replace(",", "")) for x in re.findall(r"\$([\d,]+)", s or "")]
    if not nums:
        return None, None
    return min(nums), max(nums)


def read(fn):
    try:
        return open(fn).read()
    except FileNotFoundError:
        print(f"warning: {fn} missing, skipping")
        return ""


def parse_zillow(fn="zillow.html", beds=2):
    out = []
    html = read(fn)
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        print(f"warning: no __NEXT_DATA__ in {fn} (blocked?), skipping")
        return out
    d = json.loads(m.group(1))

    def find(obj, key, depth=0):
        if depth > 10:
            return None
        if isinstance(obj, dict):
            if key in obj:
                return obj[key]
            for v in obj.values():
                r = find(v, key, depth + 1)
                if r is not None:
                    return r
        elif isinstance(obj, list):
            for v in obj:
                r = find(v, key, depth + 1)
                if r is not None:
                    return r

    for it in find(d, "listResults") or []:
        units = it.get("units") or []
        two_bed = [u for u in units if str(u.get("beds")) == str(beds)]
        if not two_bed:
            continue
        prices = [p for u in two_bed for p in parse_price(u.get("price", "")) if p]
        ll = it.get("latLong") or {}
        out.append({
            "source": "zillow",
            "title": it.get("buildingName") or it.get("statusText") or it.get("address"),
            "price_min": min(prices) if prices else None,
            "price_max": max(prices) if prices else None,
            "beds": beds,
            "address": it.get("address"),
            "lat": ll.get("latitude"),
            "lng": ll.get("longitude"),
            "url": "https://www.zillow.com" + it.get("detailUrl", ""),
        })
    return out


def parse_craigslist(fn="craigslist.html", beds=2):
    out = []
    html = read(fn)
    # coords from JSON-LD, keyed by normalized title
    coords = {}
    for m in re.findall(r'<script type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            d = json.loads(m)
        except json.JSONDecodeError:
            continue
        for e in d.get("itemListElement", []):
            it = e.get("item", {})
            if "latitude" in it:
                coords[re.sub(r"\s+", " ", it.get("name", "")).strip().lower()] = (it["latitude"], it["longitude"])
    # cards from rendered DOM
    cards = re.findall(
        r'<div data-pid="(\d+)" class="cl-search-result[^"]*" title="([^"]*)">(.*?)(?=<div data-pid=|$)',
        html, re.S)
    for pid, title, body in cards:
        title = htmlmod.unescape(title)
        pm = re.search(r'class="priceinfo">\s*(\$[\d,]+)', body)
        lm = re.search(r'class="result-location">([^<]*)', body)
        am = re.search(r'<a class="main" href="([^"]+)"', body)
        mn, mx = parse_price(pm.group(1) if pm else "")
        loc = htmlmod.unescape(lm.group(1)).strip() if lm else ""
        lat, lng = coords.get(re.sub(r"\s+", " ", title).strip().lower(), (None, None))
        out.append({
            "source": "craigslist",
            "title": title,
            "price_min": mn, "price_max": mx,
            "beds": beds,
            "address": loc or None,
            "lat": lat, "lng": lng,
            "url": am.group(1) if am else None,
        })
    return out


def parse_rentcafe(fn="rentcafe.html", beds=2):
    out = []
    html = read(fn)
    blocks = re.split(r'<div class="listing-information">', html)[1:]
    for b in blocks:
        bed_m = re.search(r'class="listing-bed">([^<]*)', b)
        if not bed_m or str(beds) not in bed_m.group(1):
            continue
        pr_m = re.search(r'class="listing-price">([^<]*)', b)
        nm_m = re.search(r'class="listing-name[^"]*"[^>]*title="([^"]*)"[^>]*>\s*<a[^>]*href="([^"]+)"', b)
        ad_m = re.search(r'class="listing-address[^"]*"[^>]*>(.*?)</', b, re.S)
        mn, mx = parse_price(pr_m.group(1) if pr_m else "")
        out.append({
            "source": "rentcafe",
            "title": htmlmod.unescape(nm_m.group(1)).strip() if nm_m else None,
            "price_min": mn, "price_max": mx,
            "beds": beds,
            "address": re.sub(r"\s+", " ", htmlmod.unescape(re.sub(r"<[^>]+>", "", ad_m.group(1)))).strip() if ad_m else None,
            "lat": None, "lng": None,
            "url": nm_m.group(2) if nm_m else None,
        })
    return out


def parse_apartments():
    try:
        html = open("apartments.html").read()
    except FileNotFoundError:
        return []
    out = []
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        return out
    d = json.loads(m.group(1))

    def find_all(obj, key, acc, depth=0):
        if depth > 12:
            return
        if isinstance(obj, dict):
            if key in obj and isinstance(obj[key], list):
                acc.extend(obj[key])
            for v in obj.values():
                find_all(v, key, acc, depth + 1)
        elif isinstance(obj, list):
            for v in obj:
                find_all(v, key, acc, depth + 1)

    placards = []
    find_all(d, "placards", placards)
    for it in placards:
        loc = it.get("location") or {}
        price = it.get("price") or it.get("displayPrice") or ""
        mn, mx = parse_price(str(price))
        out.append({
            "source": "apartments.com",
            "title": it.get("name") or it.get("displayName"),
            "price_min": mn, "price_max": mx,
            "beds": 2,
            "address": loc.get("fullAddress") or it.get("address"),
            "lat": loc.get("latitude"), "lng": loc.get("longitude"),
            "url": it.get("url") or it.get("listingUrl"),
        })
    return out


def parse_uo_offcampus(prefix="uo_offcampus", beds=2):
    out = []
    import glob
    files = [f"{prefix}.html"] + sorted(glob.glob(f"{prefix}_p*.html"))
    seen = set()
    for fn in files:
        html = read(fn)
        if not html:
            continue
        for c in re.findall(r"<fr-listing-card.*?</fr-listing-card>", html, re.S):
            t = re.search(r'id="[a-z0-9]+-title"[^>]*>\s*<a[^>]*href="(/housing/[^"]+)"[^>]*>(.*?)</a>', c, re.S)
            if not t:
                continue
            url, title = t.group(1), re.sub(r"\s+", " ", htmlmod.unescape(re.sub(r"<[^>]+>", "", t.group(2)))).strip()
            if url in seen:
                continue
            seen.add(url)
            pr = re.search(r'data-qaid="price-range"[^>]*>([^<]*)', c)
            per_bed = "/Bedroom" in c or "Per Bedroom" in c or "per bedroom" in c.lower()
            d = re.search(r"([\d.]+)\s*miles to UO", c)
            addr = re.search(r'class="[^"]*address-container[^"]*"[^>]*>\s*<p[^>]*>(.*?)</p>', c, re.S)
            mn, mx = parse_price(pr.group(1) if pr else "")
            out.append({
                "source": "uo-offcampus",
                "title": title,
                "price_min": mn, "price_max": mx,
                "per_bed": per_bed,
                "beds": beds,
                "address": re.sub(r"\s+", " ", htmlmod.unescape(re.sub(r"<[^>]+>", "", addr.group(1)))).strip() if addr else None,
                "dist_mi": float(d.group(1)) if d else None,
                "lat": None, "lng": None,
                "url": "https://offcampushousing.uoregon.edu" + url,
            })
    return out


if __name__ == "__main__":
    listings = (parse_craigslist() + parse_zillow() + parse_rentcafe() + parse_apartments()
                + parse_uo_offcampus()
                + parse_craigslist("craigslist_1br.html", 1)
                + parse_zillow("zillow_1br.html", 1)
                + parse_rentcafe("rentcafe_1br.html", 1)
                + parse_uo_offcampus("uo_offcampus_1br", 1))
    listings = [l for l in listings if l.get("title")]
    seen = set()
    deduped = []
    for l in listings:
        key = (l["source"], l.get("beds"), l.get("url") or (l.get("title"), l.get("price_min")))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(l)
    listings = deduped
    for l in listings:
        l["price_sort"] = l["price_min"] if l["price_min"] is not None else 999999
    listings.sort(key=lambda l: l["price_sort"])
    json.dump(listings, open("listings.json", "w"), indent=1)
    from collections import Counter
    print(len(listings), Counter(l["source"] for l in listings))
    print("missing coords:", sum(1 for l in listings if not l["lat"]))
