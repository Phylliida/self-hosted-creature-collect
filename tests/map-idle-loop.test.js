// Guards against the map never going idle (Oct 2026, "the app lags on
// the bus"). The tappable-POI halo refresh runs on every map 'idle';
// it used to setData() the halo source unconditionally, and every
// setData re-tiles the source, re-places labels (with a fade) and
// renders until the map is idle again — which scheduled the next
// refresh. ~3 refreshes and ~50 frames a second, forever, for every
// player, even standing still. The refresh must only setData when the
// set of halos actually changes.
//
// Runs the real functions from static/index.html against a fake map.
// Run: node tests/map-idle-loop.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');

function sliceFn(src, head) {
  const start = src.indexOf(head);
  if (start < 0) throw new Error('not found: ' + head);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced: ' + head);
}
// From the halo constants through addTappablePoiHaloLayer (state + all
// the halo functions, in their real order).
const blockStart = indexSrc.indexOf("  const TAPPABLE_HALO_LAYER_ID = 'tappable-poi-halo';");
const addFn = sliceFn(indexSrc, 'function addTappablePoiHaloLayer(');
const blockEnd = indexSrc.indexOf(addFn) + addFn.length;
ok(blockStart > 0 && blockEnd > blockStart, 'halo block found in index.html');
const block = indexSrc.slice(blockStart, blockEnd);

// Fake map: one geojson source whose setData calls are counted; the
// queried POIs are whatever the test puts in `rendered`.
function makeMap() {
  const m = {
    sources: {}, layers: {}, setDataCalls: 0, rendered: [],
    getSource(id) { return m.sources[id]; },
    addSource(id, spec) {
      m.sources[id] = { data: spec.data, setData(d) { m.setDataCalls++; this.data = d; } };
    },
    removeSource(id) { delete m.sources[id]; },
    getLayer(id) { return id === 'poi-icons' ? {} : m.layers[id]; },
    addLayer(spec) { m.layers[spec.id] = spec; },
    project([lng, lat]) { return { x: lng * 1e5, y: -lat * 1e5 }; },
    queryRenderedFeatures() { return m.rendered.slice(); },
  };
  return m;
}
const map = makeMap();
const ctx = {
  map,
  window: { Creatures: { isEnabled: () => true, isFocusActive: () => ctx.focus } },
  focus: false,
  lastKnownPos: { lat: 44.05, lng: -123.09 },
  POI_COLLECT_MAX_DISTANCE_M: 40,
  _currentCooldownReadyColor: '#0a0',
  haversineKm(lat1, lng1, lat2, lng2) {
    const dy = (lat2 - lat1) * 111, dx = (lng2 - lng1) * 111 * Math.cos(lat1 * Math.PI / 180);
    return Math.hypot(dx, dy);
  },
  poiCooldownStatus: () => 'ready',
  buildingFeatureCentroid: () => null,
  requestAnimationFrame: (f) => f(),
  performance: { now: () => 0 },
};
vm.createContext(ctx);
vm.runInContext(block + '\nthis.refresh = refreshTappablePoiHalos; this.add = addTappablePoiHaloLayer;', ctx);

const poi = (dLatM, dLngM) => ({ geometry: { type: 'Point', coordinates: [
  -123.09 + dLngM / (111000 * Math.cos(44.05 * Math.PI / 180)), 44.05 + dLatM / 111000] } });
const A = poi(10, 0), B = poi(-5, 12), FAR = poi(500, 0);

ctx.add();
ok(map.setDataCalls === 0, 'creating the source does not setData');
// Nothing in range: the source already holds an empty collection.
map.rendered = [FAR];
ctx.refresh();
ok(map.setDataCalls === 0, 'no halos in range, empty source → no setData');
map.rendered = [A, B];
ctx.refresh();
ok(map.setDataCalls === 1, 'halos appear → one setData');
ok(map.sources['tappable-pois'].data.features.length === 2, 'both in-range POIs get a halo');
// The idle → refresh path, many times over: no change, no setData.
for (let i = 0; i < 20; i++) ctx.refresh();
ok(map.setDataCalls === 1, 'repeated refreshes with the same halos → no setData (no idle loop)');
map.rendered = [B, A, A, FAR];
ctx.refresh();
ok(map.setDataCalls === 1, 'same halos in another order / duplicated → no setData');
map.rendered = [A];
ctx.refresh();
ok(map.setDataCalls === 2, 'a halo goes away → setData');
ok(map.sources['tappable-pois'].data.features.length === 1, '…with the remaining halo');
// Focus mode hides every halo: one clear, then quiet.
ctx.focus = true;
ctx.refresh(); ctx.refresh(); ctx.refresh();
ok(map.setDataCalls === 3, 'focus mode clears the halos once');
ok(map.sources['tappable-pois'].data.features.length === 0, '…to an empty collection');
ctx.focus = false;
ctx.refresh();
ok(map.setDataCalls === 4, 'leaving focus mode brings the halo back');
// A style reload drops the source; the re-created one starts empty, so
// the same halos must be pushed again.
map.removeSource('tappable-pois');
ctx.add();
ctx.refresh();
ok(map.setDataCalls === 5 && map.sources['tappable-pois'].data.features.length === 1,
  're-created source gets its halos again');
ctx.refresh();
ok(map.setDataCalls === 5, '…and then stays quiet');

console.log(`map-idle-loop: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
