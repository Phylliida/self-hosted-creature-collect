/**
 * Perturbation version of the Kaliset (zₙ₊₁ = abs(zₙ)/dot(zₙ,zₙ) − c) for deep zoom past the float
 * engine's ~1e13. With z = Z + ε and a high-precision reference orbit Zₙ the iteration perturbs
 * cancellation-free:
 *
 *   abs:  nₓ = diffabs(Zₓ, εₓ)              (exact, any sign)            n = |z| − |Z|
 *   dot:  d  = 2(Zₓεₓ + Z_yε_y) + (εₓ²+ε_y²)                            d = |z|² − |Z|²
 *   then  abs(z)/dot(z,z) − abs(Z)/dot(Z,Z)  =  (n·D − A·d) / (D·(D+d)) per component,
 *   so    ε' = ((nₓD − Aₓd)/(D(D+d)) − δₓ,  (n_yD − A_yd)/(D(D+d)) − δ_y)     (δ = 0 in Julia mode)
 *
 * where D = dot(Z,Z), A = |Z|. Coloured by the same orbit trap as the float engine (mean closeness
 * to the origin). The Kaliset is strongly chaotic, so the perturbation decorrelates and falls back
 * to an exact per-pixel orbit in the chaotic regions; at deep zoom and in the smoother regions the
 * orbit (capped at KALI_MAX_TRAP iterations) is short enough to track in full, where it pays off.
 * Reuses the multibrot perturbation's reference machinery: last-good-first, capped reference scan,
 * exact own-orbit fallback.
 */
import {WorkerContext} from "./workerContext.js";
import {KALI_GLOW, KALI_MAX_TRAP, closenessToValue} from "./mandelbrotKali.js";

// |c + d| − |c|, exact in every sign combination (no cancellation).
function diffabs(c, d) {
    if (c >= 0) {
        return c + d >= 0 ? d : -d - 2 * c
    }
    return c + d > 0 ? d + 2 * c : -d
}

// Kali references are all the same length, so there is no "longest-first" payoff to a wide scan;
// in the chaotic / transition regime they all glitch, making the scan pure overhead before the
// inevitable own-orbit. Keep the floor small (the last-good fast path carries the deep regime).
const MIN_REFERENCE_SCAN = 4
// The orbit trap (a sum of exp(−|z|²)) needs the orbit accurate, not merely non-decorrelated, so
// glitch as soon as ε reaches √(1/this) of the orbit magnitude (|z|² < |ε|²·K) — well before the
// gross |z|<|ε| decorrelation, which would already have corrupted the closeness. Tunable via
// this.glitchFactor (for benchmarking); deep zoom keeps ε tiny so it never fires regardless.
const KALI_GLITCH_FACTOR = 1e6
// Reference layout (Float64Array, stride 6 per orbit point): X, Y, |X|, |Y|, dot, errorBound.
const STRIDE = 6

export class MandelbrotKaliPerturbation {
    /**
     * @param {WorkerContext} ctx
     */
    constructor(ctx) {
        this.ctx = ctx
        this.paramHash = null
        this.jobId = null
        this.referencePoints = []
    }

    async process(task) {
        this.max_iter = task.maxIter
        this.trapIters = Math.min(task.maxIter, KALI_MAX_TRAP)
        this.julia = task.julia === true
        this.glitch = this.glitchFactor ?? KALI_GLITCH_FACTOR
        const w = task.w
        const h = task.h

        const values = new Int32Array(w * h)
        const smooth = task.smooth ? new Uint8ClampedArray(w * h) : null
        const start = performance.now()
        this.calculate(values, smooth, w, h, task.skipTopLeft, task)
        const end = performance.now()

        return {
            type: 'answer',
            task: task,
            values: values,
            smooth: smooth,
            stats: {
                time: end - start,
                timeHighPrecision: this.ctx.stats.timeSpendInHighPrecision,
                highPrecisionCalculations: this.ctx.stats.numberOfHighPrecisionPoints,
                lowPrecisionMisses: this.ctx.stats.numberOfLowPrecisionMisses,
            }
        }
    }

    calculate(values, smooth, w, h, skipTopLeft, task) {
        const stats = this.ctx.stats
        const scale = task.precision
        const scaleFactor = Math.pow(2, Number(scale))
        const bigScale = BigInt(scale)
        const rmin = task.frameTopLeft[0]
        const rmax = task.frameBottomRight[0]
        const imin = task.frameTopLeft[1]
        const imax = task.frameBottomRight[1]
        const cWidth = Number(rmax.subtract(rmin).bigInt) / scaleFactor
        const cHeight = Number(imax.subtract(imin).bigInt) / scaleFactor
        const refr = rmin.bigInt
        const refi = imin.bigInt

        if (this.julia) {
            this.cxFx = task.juliaSeed[0].withScale(scale).bigInt
            this.cyFx = task.juliaSeed[1].withScale(scale).bigInt
        }

        this.updateCache(task, cWidth, cHeight, scaleFactor)

        if (this.referencePoints.length === 0) {
            const dr = (task.xOffset + Math.trunc(w / 2)) / task.frameWidth * cWidth
            const di = (task.yOffset + Math.trunc(h / 2)) / task.frameHeight * cHeight
            this.referencePoints.push(this.calculate_reference(refr, refi, dr, di, bigScale, scaleFactor))
            if (this.ctx.shouldStop()) return
        }

        let lastRefIndex = 0
        const maxRefScan = this.maxRefScan ?? Math.max(MIN_REFERENCE_SCAN, Math.round(scale * scale / 9000))

        for (let y = 0; y < h; y++) {
            const di = (task.yOffset + y) / task.frameHeight * cHeight
            const skipLeft = skipTopLeft && y % 2 === 0

            for (let x = 0; x < w; x++) {
                if (skipLeft && x % 2 === 0) continue
                const dr = (task.xOffset + x) / task.frameWidth * cWidth
                const offset = y * w + x
                const referencePoints = this.referencePoints
                const numRefs = referencePoints.length
                let found = false

                // Fast path: the previous pixel's reference almost always works here too.
                if (this.fastReference !== false && lastRefIndex < numRefs) {
                    const closeness = this.perturb(referencePoints[lastRefIndex], dr, di)
                    if (closeness >= 0) {
                        closenessToValue(closeness, offset, values, smooth, this.max_iter)
                        found = true
                        stats.numberOfLowPrecisionPoints++
                    } else {
                        stats.numberOfLowPrecisionMisses++
                    }
                }

                if (!found) {
                    // Cap the scan: a pixel that glitches against the references in the list has to
                    // compute its own exact orbit anyway, so scanning all of them is wasted work in
                    // the chaotic regions. The fallback is exact, so the result is unchanged.
                    let scanned = 0
                    for (let refIndex = 0; refIndex < numRefs; refIndex++) {
                        if (refIndex === lastRefIndex) continue
                        if (scanned++ >= maxRefScan) break
                        const closeness = this.perturb(referencePoints[refIndex], dr, di)
                        if (closeness >= 0) {
                            closenessToValue(closeness, offset, values, smooth, this.max_iter)
                            found = true
                            lastRefIndex = refIndex
                            stats.numberOfLowPrecisionPoints++
                            break
                        }
                        stats.numberOfLowPrecisionMisses++
                    }
                }

                if (!found) {
                    const newRef = this.calculate_reference(refr, refi, dr, di, bigScale, scaleFactor)
                    closenessToValue(newRef[1], offset, values, smooth, this.max_iter)
                    referencePoints.push(newRef) // all references are the same length — no ordering
                    lastRefIndex = referencePoints.length - 1
                    if (this.ctx.shouldStop()) return
                }
            }
            if (this.ctx.shouldStop()) return
        }
    }

    updateCache(task, cWidth, cHeight, scaleFactor) {
        if (task.jobId !== this.jobId) {
            this.jobId = task.jobId
            if (this.paramHash !== task.paramHash || this.referencePoints.length === 0 || task.resetCaches) {
                this.paramHash = task.paramHash
                this.referencePoints = []
            } else if (task.precision === this.precision) {
                // Keep reference points still inside the frame after a pan.
                const oldReferencePoints = this.referencePoints
                this.referencePoints = []
                const deltar = Number(task.frameTopLeft[0].subtract(this.topLeft[0]).bigInt) / scaleFactor
                const deltai = Number(task.frameTopLeft[1].subtract(this.topLeft[1]).bigInt) / scaleFactor
                for (const referencePoint of oldReferencePoints) {
                    const dr = referencePoint[0][0] - deltar
                    const di = referencePoint[0][1] - deltai
                    if (dr < cWidth && di < cHeight) {
                        referencePoint[0] = [dr, di]
                        this.referencePoints.push(referencePoint)
                    }
                }
            } else {
                this.referencePoints = []
            }
            this.precision = task.precision
            this.topLeft = task.frameTopLeft
        }
    }

    // One perturbation attempt of pixel (dr, di) against a reference point. δ = (dr,di)−(refDr,refDi)
    // is both ε₀ and (in the parameter plane) the per-step c offset; in Julia mode c is fixed so the
    // per-step offset is 0. Returns the mean closeness (>= 0) or -1 when the perturbation glitches.
    perturb(referencePoint, dr, di) {
        const dcr = dr - referencePoint[0][0]
        const dci = di - referencePoint[0][1]
        const adr = this.julia ? 0 : dcr
        const adi = this.julia ? 0 : dci
        return this.kali_perturbation(dcr, dci, adr, adi, referencePoint[2], referencePoint[3])
    }

    /**
     * @param {Float64Array} zs reference orbit, stride 6: X, Y, |X|, |Y|, dot, errorBound
     * @returns {number} mean closeness (>= 0) or -1 on a glitch (decorrelation / near-origin)
     */
    kali_perturbation(e0r, e0i, adr, adi, zs, numZs) {
        let u = e0r
        let v = e0i
        let sum = 0
        let n = 0
        for (let iter = 0; iter < numZs; iter++) {
            const base = iter * STRIDE
            const X = zs[base]
            const Y = zs[base + 1]
            const Ax = zs[base + 2]
            const Ay = zs[base + 3]
            const D = zs[base + 4]

            // z = Z + ε
            const zx = X + u
            const zy = Y + v
            const dotPix = zx * zx + zy * zy
            // Glitch: orbit near the origin relative to the reference (Pauldelbrot), or ε grown as
            // large as the orbit (decorrelation) — either corrupts the rest of the trap accumulation.
            if (dotPix < zs[base + 5] || dotPix < (u * u + v * v) * this.glitch) {
                return -1
            }

            if (iter > 0) {
                sum += Math.exp(-dotPix * KALI_GLOW)
                n++
            }

            // ε' = (nₓD − Aₓd)/(D(D+d)) − δ , per component
            const nx = diffabs(X, u)
            const ny = diffabs(Y, v)
            const d = 2 * (X * u + Y * v) + (u * u + v * v)
            const denom = D * (D + d)
            const pu = (nx * D - Ax * d) / denom
            const pv = (ny * D - Ay * d) / denom
            u = pu - adr
            v = pv - adi
            if (!Number.isFinite(u) || !Number.isFinite(v)) {
                return -1
            }
        }
        return n > 0 ? sum / n : 0
    }

    /**
     * @returns {[[number, number], number, Float64Array, number]} [dr,di], closeness, zs, numZs
     */
    calculate_reference(refr, refi, dr, di, bigScale, scaleFactor) {
        const start = performance.now()
        const rr = refr + BigInt(Math.round(dr * scaleFactor))
        const ri = refi + BigInt(Math.round(di * scaleFactor))
        // z₀ is the reference point; c is the captured seed (Julia) or the point itself (parameter plane).
        const cx = this.julia ? this.cxFx : rr
        const cy = this.julia ? this.cyFx : ri
        const seq = this.kali_high_precision(rr, ri, cx, cy, this.trapIters, bigScale)
        const numZs = seq.length
        const zs = new Float64Array(numZs * STRIDE)
        let sum = 0
        let n = 0
        for (let idx = 0, base = 0; idx < numZs; idx++, base += STRIDE) {
            const x = Number(seq[idx][0]) / scaleFactor
            const y = Number(seq[idx][1]) / scaleFactor
            const dot = x * x + y * y
            zs[base] = x
            zs[base + 1] = y
            zs[base + 2] = Math.abs(x)
            zs[base + 3] = Math.abs(y)
            zs[base + 4] = dot
            zs[base + 5] = dot * 0.000001
            if (idx > 0) {
                sum += Math.exp(-dot * KALI_GLOW)
                n++
            }
        }
        const closeness = n > 0 ? sum / n : 0
        this.ctx.stats.timeSpendInHighPrecision += performance.now() - start
        this.ctx.stats.numberOfHighPrecisionPoints++
        return [[dr, di], closeness, zs, numZs]
    }

    /**
     * The reference orbit zₙ₊₁ = abs(zₙ)/dot(zₙ,zₙ) − c in fixed point (BigInt). abs is a sign flip,
     * the division is (|z|·2^scale) / dot. Stops early only if the orbit hits the exact origin.
     * @returns {[BigInt, BigInt][]} the orbit points
     */
    kali_high_precision(z0x, z0y, cx, cy, n, scale) {
        const seq = []
        let zx = z0x
        let zy = z0y
        for (let i = 0; i < n; i++) {
            seq.push([zx, zy])
            const dot = ((zx * zx) >> scale) + ((zy * zy) >> scale)
            if (dot === 0n) {
                break // exactly at the origin — division undefined
            }
            const ax = zx < 0n ? -zx : zx
            const ay = zy < 0n ? -zy : zy
            zx = ((ax << scale) / dot) - cx
            zy = ((ay << scale) / dot) - cy
        }
        return seq
    }
}
