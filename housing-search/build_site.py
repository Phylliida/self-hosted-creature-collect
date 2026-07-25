"""Generate index.html: sortable/filterable table of listings with embedded data."""
import json

listings = json.load(open("listings.json"))

# normalize: per-bed pricing flagged so the UI can show it
data = []
for l in listings:
    data.append({
        "t": l.get("title"),
        "a": l.get("address"),
        "beds": l.get("beds") or 2,
        "pmin": l.get("price_min"),
        "pmax": l.get("price_max"),
        "perbed": bool(l.get("per_bed")),
        "src": l.get("source"),
        "url": l.get("url"),
        "bus": l.get("bus_min"),
        "busd": l.get("bus_desc"),
        "busp": l.get("bus_parts"),
        "lat": l.get("lat"),
        "lng": l.get("lng"),
        "groc": [{"n": g["name"], "w": g["walk_min"], "b": g["bus_min"], "bp": g.get("bus_parts")}
                for g in (l.get("groceries") or [])],
        "laund": ({"n": l["laundry"]["name"], "w": l["laundry"]["walk_min"]}
                  if l.get("laundry") else None),
    })

html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eugene 2-Bed Rentals → Bus to UO</title>
<style>
  :root { --green:#0a7c42; --bg:#f6f7f4; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; background: var(--bg); color: #1a1a1a; }
  header { background: var(--green); color: #fff; padding: 16px 20px; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header p { margin: 0; font-size: 13px; opacity: .9; max-width: 900px; }
  #controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 12px 20px; background: #fff; border-bottom: 1px solid #ddd; position: sticky; top: 0; z-index: 2; font-size: 14px; }
  #controls label { display: flex; gap: 4px; align-items: center; }
  input[type=number] { width: 80px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #e3e3e3; }
  th { background: #fff; cursor: pointer; user-select: none; white-space: nowrap; position: sticky; top: 54px; }
  th .arrow { color: var(--green); }
  tbody tr:hover { background: #eef5ef; }
  .price { font-weight: 600; white-space: nowrap; }
  .perbed { color: #8a6d00; font-size: 11px; }
  .bus { white-space: nowrap; }
  .bus.good { color: var(--green); font-weight: 600; }
  .bus.meh { color: #9a6a00; }
  .bus.bad { color: #a33; }
  .bus-sub { font-size: 11px; color: #777; white-space: nowrap; }
  .src { font-size: 11px; color: #666; white-space: nowrap; }
  .addr { color: #555; font-size: 13px; }
  .groc { font-size: 12px; color: #444; }
  .groc-row { white-space: nowrap; }
  .groc-name { font-weight: 600; }
  .beds1 { background: #e8d44d; color: #4a3f00; font-size: 10px; font-weight: 700; padding: 1px 4px; border-radius: 3px; }
  a { color: #0a5ac2; }
  #count { font-weight: 600; }
</style>
</head>
<body>
<header>
  <h1>Eugene, OR — 1 &amp; 2-bedroom rentals, sorted by price &amp; bus time to UO</h1>
  <p>Scraped __DATE__ from Craigslist, Zillow, RentCafe &amp; UO Off-Campus Housing (apartments.com blocked the scraper).
  Bus times are estimates from LTD's GTFS feed (Fall 2025 schedule, weekday morning ~7–9:30am, walk &le; 900m to stop, half-headway wait). Verify schedules at ltd.org. Prices with a "/bd" note are per-bedroom.
  Note: many 1-bedroom leases limit occupancy to 2 people — check with the landlord before planning on 3.</p>
</header>
<div id="controls">
  <span id="count"></span>
  <label>max price $<input type="number" id="maxPrice" placeholder="any"></label>
  <label>max bus <input type="number" id="maxBus" placeholder="any" style="width:60px"> min</label>
  <label>source:
    <select id="srcSel"><option value="">all</option></select>
  </label>
  <label><input type="checkbox" id="hideNoBus"> hide listings with no bus estimate</label>
  <label><input type="checkbox" id="hidePerBed"> hide per-bedroom (student-style) listings</label>
  <label>beds: <input type="checkbox" id="bed1" checked> 1 <input type="checkbox" id="bed2" checked> 2</label>
</div>
<table id="tbl">
  <thead><tr>
    <th data-k="pmin">Price</th>
    <th data-k="bus">Bus to UO</th>
    <th data-k="t">Listing</th>
    <th data-k="a">Address / area</th>
    <th>Groceries (walk / bus) + laundromat</th>
    <th data-k="src">Source</th>
    <th>Link</th>
  </tr></thead>
  <tbody></tbody>
</table>
<script>
const DATA = __DATA__;
let sortKey = "pmin", sortDir = 1;
const fmt$ = v => v == null ? "" : "$" + v.toLocaleString();

function priceText(l) {
  if (l.pmin == null) return "call";
  let s = l.pmax && l.pmax !== l.pmin ? fmt$(l.pmin) + "–" + fmt$(l.pmax) : fmt$(l.pmin);
  return s + (l.perbed ? ' <span class="perbed">/bd</span>' : "");
}
function busText(l) {
  if (l.bus == null) return '<span class="bus bad">—</span>';
  const cls = l.bus <= 25 ? "good" : l.bus <= 45 ? "meh" : "bad";
  let sub = "";
  if (l.busp) {
    sub = `<div class="bus-sub">${l.busp.walk}m🚶 ${l.busp.wait}m⏳ ${l.busp.ride}m🚌</div>` +
          `<div class="bus-sub">${l.busp.route}</div>`;
  }
  return `<span class="bus ${cls}">${l.bus} min</span>${sub}`;
}
function grocText(l) {
  let rows = (l.groc || []).map(g => {
    const tip = g.bp ? ` title="${g.bp.walk}m walk + ${g.bp.wait}m wait + ${g.bp.ride}m ride (${g.bp.route})"` : "";
    const bus = g.b == null ? "—" : `<span${tip}>${g.b}m🚌</span>`;
    return `<div class="groc-row"><span class="groc-name">${g.n}</span> ${g.w}m🚶 ${bus}</div>`;
  });
  if (l.laund) {
    rows.push(`<div class="groc-row">🧺 <span class="groc-name">${l.laund.n}</span> ${l.laund.w}m🚶</div>`);
  }
  return rows.length ? rows.join("") : '<span class="bus bad">—</span>';
}
function render() {
  const maxP = +document.getElementById("maxPrice").value || Infinity;
  const maxB = +document.getElementById("maxBus").value || Infinity;
  const src = document.getElementById("srcSel").value;
  const hideNoBus = document.getElementById("hideNoBus").checked;
  const hidePerBed = document.getElementById("hidePerBed").checked;
  const beds = new Set();
  if (document.getElementById("bed1").checked) beds.add(1);
  if (document.getElementById("bed2").checked) beds.add(2);
  let rows = DATA.filter(l =>
    (l.pmin == null || l.pmin <= maxP) &&
    (l.bus == null ? !hideNoBus : l.bus <= maxB) &&
    (!hidePerBed || !l.perbed) &&
    beds.has(l.beds) &&
    (!src || l.src === src));
  rows.sort((x, y) => {
    const a = x[sortKey] ?? 1e9, b = y[sortKey] ?? 1e9;
    return (a < b ? -1 : a > b ? 1 : 0) * sortDir;
  });
  document.getElementById("count").textContent = rows.length + " listings";
  const tb = document.querySelector("#tbl tbody");
  tb.innerHTML = rows.map(l => `<tr>
    <td class="price">${priceText(l)}</td>
    <td title="${l.busd || ""}">${busText(l)}</td>
    <td>${l.beds === 1 ? '<span class="beds1">1bd</span> ' : ""}${l.t || ""}</td>
    <td class="addr">${l.a || ""}</td>
    <td class="groc">${grocText(l)}</td>
    <td class="src">${l.src}</td>
    <td>${l.url ? `<a href="${l.url}" target="_blank" rel="noopener">view</a>` : ""}</td>
  </tr>`).join("");
}
document.querySelectorAll("th[data-k]").forEach(th => th.addEventListener("click", () => {
  const k = th.dataset.k;
  if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = 1; }
  document.querySelectorAll("th .arrow").forEach(e => e.remove());
  th.insertAdjacentHTML("beforeend", `<span class="arrow">${sortDir > 0 ? " ▲" : " ▼"}</span>`);
  render();
}));
["maxPrice", "maxBus", "srcSel", "hideNoBus", "hidePerBed", "bed1", "bed2"].forEach(id =>
  document.getElementById(id).addEventListener("input", render));
[...new Set(DATA.map(l => l.src))].sort().forEach(s =>
  document.getElementById("srcSel").insertAdjacentHTML("beforeend", `<option>${s}</option>`));
render();
</script>
</body>
</html>
"""

import datetime
html = html.replace("__DATA__", json.dumps(data)).replace("__DATE__", datetime.date.today().isoformat())
open("index.html", "w").write(html)
print(f"index.html written, {len(data)} listings")
