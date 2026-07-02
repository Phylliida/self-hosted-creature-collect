// Pure time-dependent Dijkstra over a walk + transit graph.
//
// Node keys are `w:<walkNodeId>` or `s:<gtfsStopId>`.
// PQ entries are `[cost, key, wallClock]`. Priority is cost only;
// wall-clock rides along for schedule lookups.
//
// Cost model (the only assumption):
//   walking second       = walkWeight
//   non-walking second   = 1      (wait + ride on transit)
// At walkWeight=1 cost == wall-clock; at walkWeight=5 a walking second
// costs 5× a transit second. Nothing else is baked in.
//
// Time units everywhere are SECONDS. Walk edges carry `.walkSec`;
// walkNodeToStops / stopToWalkNode use `walkSec` for the connector time.
// No meter-to-second conversion inside this module.
//
// `deps`:
//   walkGraph        Graph exposing a small accessor API:
//                      hasNode(nodeId), lng(nodeId), lat(nodeId),
//                      forEachNeighbor(nodeId, fn) where
//                        fn(toNodeId, weightMetres, edgeRef) is called per
//                        outgoing edge. edgeRef is opaque to the planner —
//                        whatever shape walkGraph wants (legacy uses
//                        {edgeIdx, reverse}; multi-graph uses
//                        {regionIdx, adjIdx, from, to} or {portal: true}).
//                    Node identifiers are opaque too: legacy uses internal
//                    uint32 indices, multi-graph uses packed globalIds.
//                    Whatever they are, they must be safe for use as a
//                    Map key (numbers + string concat) and round-trippable
//                    via String→Number.
//   walkSpeedMps     metres/second walking speed for converting an edge's
//                    weight (in metres) into seconds. Optional; defaults
//                    to 1.3.
//   scheduleIdx      { stopPatterns, patternBboxStops, stopToWalkNode,
//                      walkNodeToStops }
//   MinHeap          class
//
// Per-call `activeTrips(patternId)` → array of `{ trip, f, cum }`:
//   f    = effective first-stop departure (seconds; caller applies any
//          service-day offset).
//   cum  = cumulative stop-to-stop delta array, so trip reaches stop
//          at index `seq` at time `f + cum[seq]`.
//   trip = opaque reference echoed back in the 'transit' step.
//
// Returned plan:
//   { steps: [...], startSec, endSec }
// where `steps` is the raw origin→dest chain with entries:
//   { type: 'walk',    edge, fromNode, toNode, tDep, tArr }
//   { type: 'access',  stopId, fromNode, walkSec, tDep, tArr }
//   { type: 'egress',  stopId, toNode,   walkSec, tDep, tArr }
//   { type: 'transit', trip, patternId, fromStopId, toStopId,
//                      fromSeq, toSeq, tDep, tArr }

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve
  global._scriptVersions = global._scriptVersions || {};
  global._scriptVersions['trip-planner.js'] = SCRIPT_VERSION;

  function create(deps) {
    const { MinHeap } = deps;
    const walkSpeedMps = deps.walkSpeedMps || 1.3;

    // Elapsed-time yield for the search loops — same pattern as the
    // app's other chunked builders. A long-route search (95km, three
    // alternatives) showed up as a single 3.0s main-thread freeze in a
    // field stall dump (2026-07-02); yielding whenever >40ms of sync
    // work has accumulated keeps the map alive while the route spinner
    // runs. Both planners are async because of this; results are
    // unchanged (the search order doesn't depend on wall clock).
    function searchYielder() {
      let last = performance.now();
      return async () => {
        if (performance.now() - last > 40) {
          await new Promise((r) => setTimeout(r, 0));
          last = performance.now();
        }
      };
    }

    // ---- forward: depart at t0, find fastest arrival ------------------

    async function planForward(originNodeId, destNodeId, t0, walkWeight, transferSec, activeTrips) {
      const wg = deps.walkGraph, si = deps.scheduleIdx;
      if (!wg.hasNode(originNodeId) || !wg.hasNode(destNodeId)) return null;
      const destKey = 'w:' + destNodeId;
      const bestCost = new Map(), came = new Map(), pq = new MinHeap();
      bestCost.set('w:' + originNodeId, 0);
      pq.push([0, 'w:' + originNodeId, t0]);

      const relax = (nk, newCost, newT, step) => {
        if (newCost < (bestCost.get(nk) ?? Infinity)) {
          bestCost.set(nk, newCost);
          came.set(nk, step);
          pq.push([newCost, nk, newT]);
        }
      };

      const maybeYield = searchYielder();
      let pops = 0;
      while (pq.size) {
        const [cost, key, t] = pq.pop();
        if ((++pops & 0x7FF) === 0) await maybeYield();
        if (cost > bestCost.get(key)) continue;
        if (key === destKey) return traceback(came, destKey, 'prev', 'unshift', t0, t);

        if (key[0] === 'w') {
          const nid = +key.slice(2);
          // forEachNeighbor unifies the legacy walkGraph + multi-graph
          // adapters. edgeRef is opaque (legacy uses {edgeIdx, reverse};
          // multi uses {regionIdx, adjIdx, ...}) — we pass it through
          // unchanged to the step so the renderer can resolve display
          // data later.
          wg.forEachNeighbor(nid, (to, weight, edgeRef) => {
            const walkSec = weight / walkSpeedMps;
            relax('w:' + to, cost + walkSec * walkWeight, t + walkSec, {
              prev: key, type: 'walk', edge: edgeRef,
              fromNode: nid, toNode: to, tDep: t, tArr: t + walkSec,
            });
          });
          for (const [stopId, walkSec] of (si.walkNodeToStops.get(nid) || [])) {
            relax('s:' + stopId, cost + walkSec * walkWeight, t + walkSec, {
              prev: key, type: 'access', stopId, walkSec, fromNode: nid,
              tDep: t, tArr: t + walkSec,
            });
          }
        } else {
          const stopId = key.slice(2);
          const link = si.stopToWalkNode.get(stopId);
          if (link) {
            relax('w:' + link.node, cost + link.walkSec * walkWeight, t + link.walkSec, {
              prev: key, type: 'egress', stopId, walkSec: link.walkSec,
              toNode: link.node, tDep: t, tArr: t + link.walkSec,
            });
          }
          const seqs = si.stopPatterns.get(stopId);
          if (!seqs) continue;
          const boardAfter = t + transferSec;
          for (const [patternId, seq] of seqs) {
            const bboxStops = si.patternBboxStops.get(patternId);
            if (!bboxStops || bboxStops.length <= 1) continue;
            let best = null;
            for (const entry of activeTrips(patternId)) {
              const dep = entry.f + (entry.cum[seq] || 0);
              if (dep < boardAfter) continue;
              if (!best || dep < best.dep) best = { entry, dep };
            }
            if (!best) continue;
            for (const [seqJ, stopJ] of bboxStops) {
              if (seqJ <= seq) continue;
              const arr = best.entry.f + (best.entry.cum[seqJ] || 0);
              if (arr <= best.dep) continue;
              relax('s:' + stopJ, cost + (arr - t), arr, {
                prev: key, type: 'transit',
                trip: best.entry.trip, patternId,
                fromStopId: stopId, toStopId: stopJ,
                fromSeq: seq, toSeq: seqJ,
                tDep: best.dep, tArr: arr,
              });
            }
          }
        }
      }
      return null;
    }

    // ---- reverse: arrive by tArr, find latest departure ---------------

    async function planReverse(originNodeId, destNodeId, tArr, walkWeight, transferSec, activeTrips) {
      const wg = deps.walkGraph, si = deps.scheduleIdx;
      if (!wg.hasNode(originNodeId) || !wg.hasNode(destNodeId)) return null;
      const origKey = 'w:' + originNodeId;
      const destKey = 'w:' + destNodeId;
      const bestCost = new Map(), came = new Map(), pq = new MinHeap();
      bestCost.set(destKey, 0);
      pq.push([0, destKey, tArr]);

      const relax = (nk, newCost, newT, step) => {
        if (newCost < (bestCost.get(nk) ?? Infinity)) {
          bestCost.set(nk, newCost);
          came.set(nk, step);
          pq.push([newCost, nk, newT]);
        }
      };

      const maybeYield = searchYielder();
      let pops = 0;
      while (pq.size) {
        const [cost, key, t] = pq.pop();
        if ((++pops & 0x7FF) === 0) await maybeYield();
        if (cost > bestCost.get(key)) continue;
        if (key === origKey) return traceback(came, origKey, 'next', 'push', t, tArr);

        if (key[0] === 'w') {
          const nid = +key.slice(2);
          // Same uniform iteration as planForward. For the direction
          // flip on the legacy walkGraph, we mutate the edgeRef copy
          // since the multi-graph version has no reverse bit (edges
          // are bidirectional by construction). The renderer treats
          // an absent reverse bit as forward.
          wg.forEachNeighbor(nid, (to, weight, edgeRef) => {
            const walkSec = weight / walkSpeedMps;
            // In reverse search we traverse neighbour→nid backward in
            // time; in forward order the leg runs to→nid, so flip the
            // legacy direction bit when present.
            let flipped = edgeRef;
            if (edgeRef && 'reverse' in edgeRef) {
              flipped = { ...edgeRef, reverse: !edgeRef.reverse };
            }
            relax('w:' + to, cost + walkSec * walkWeight, t - walkSec, {
              next: key, type: 'walk', edge: flipped,
              fromNode: to, toNode: nid,
              tDep: t - walkSec, tArr: t,
            });
          });
          for (const [stopId, walkSec] of (si.walkNodeToStops.get(nid) || [])) {
            relax('s:' + stopId, cost + walkSec * walkWeight, t - walkSec, {
              next: key, type: 'egress', stopId, walkSec, toNode: nid,
              tDep: t - walkSec, tArr: t,
            });
          }
        } else {
          const stopId = key.slice(2);
          const link = si.stopToWalkNode.get(stopId);
          if (link) {
            relax('w:' + link.node, cost + link.walkSec * walkWeight, t - link.walkSec, {
              next: key, type: 'access', stopId, walkSec: link.walkSec,
              fromNode: link.node, tDep: t - link.walkSec, tArr: t,
            });
          }
          const seqs = si.stopPatterns.get(stopId);
          if (!seqs) continue;
          for (const [patternId, seq] of seqs) {
            const bboxStops = si.patternBboxStops.get(patternId);
            if (!bboxStops || bboxStops.length <= 1) continue;
            let best = null;
            for (const entry of activeTrips(patternId)) {
              const arr = entry.f + (entry.cum[seq] || 0);
              if (arr > t) continue;
              if (!best || arr > best.arr) best = { entry, arr };
            }
            if (!best) continue;
            for (const [seqJ, stopJ] of bboxStops) {
              if (seqJ >= seq) continue;
              const dep = best.entry.f + (best.entry.cum[seqJ] || 0);
              if (dep >= best.arr) continue;
              const arrAtJ = dep - transferSec;
              relax('s:' + stopJ, cost + (t - arrAtJ), arrAtJ, {
                next: key, type: 'transit',
                trip: best.entry.trip, patternId,
                fromStopId: stopJ, toStopId: stopId,
                fromSeq: seqJ, toSeq: seq,
                tDep: dep, tArr: best.arr,
              });
            }
          }
        }
      }
      return null;
    }

    // Both planners are async (they yield to the event loop during long
    // searches) — callers must await them.
    return { planForward, planReverse };
  }

  function traceback(came, terminal, linkField, orderOp, startSec, endSec) {
    // Always append, then reverse when the caller asked for 'unshift'
    // order — per-step unshift is O(n²) (each prepend shifts the whole
    // array) and turned a long walking leg's thousands of edge-steps
    // into real time. push+reverse produces the identical array.
    const steps = [];
    let cursor = terminal;
    while (came.has(cursor)) {
      const step = came.get(cursor);
      steps.push({ ...step });
      cursor = step[linkField];
    }
    if (orderOp === 'unshift') steps.reverse();
    return { steps, startSec, endSec };
  }

  global.TripPlanner = { create };
})(typeof window !== 'undefined' ? window : globalThis);
