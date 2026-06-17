/**
 * Perturbation version of the multibrot iteration zₙ₊₁ = zₙ^d + c for deep zoom up to about
 * 1e300. With z = Z + ε the perturbation expands binomially and cancellation-free:
 *
 *   εₙ₊₁ = Σₖ₌₁..d C(d,k)·Zₙ^(d−k)·εₙ^k + δ
 *
 * evaluated as a Horner scheme over the binomial-scaled reference powers Bₖ = C(d,k)·Z^(d−k),
 * which are precomputed per orbit point:
 *
 *   acc = 1;  for k = d−1 .. 1:  acc = acc·ε + Bₖ;  εₙ₊₁ = acc·ε + δ
 *
 * For d = 2 this reduces exactly to the classic Mandelbrot recurrence (2·Z + ε)·ε + δ.
 * Uses the same longest-orbit-first reference machinery as the other perturbation engines.
 */
import {WorkerContext, smoothen} from "./workerContext.js";
import {DEFAULT_DEGREE} from "./mandelbrotMultibrot.js";

// Degrees at and above this use the extra decorrelation glitch test and the precision boost.
// Below it the standard perturbation already renders correctly and quickly. Keep in sync with
// the precision boost in index.js _updatePrecision.
export const HIGH_DEGREE = 5

// Floor for the per-pixel reference-scan cap (see scale-aware cap in calculate). The cap bounds
// the scan in chaotic regions where most references glitch — the fallback is an exact own orbit,
// so the rendered value is unchanged regardless of the cap.
const MIN_REFERENCE_SCAN = 16

function binomials(d) {
    const b = [1]
    for (let k = 1; k <= d; k++) {
        b[k] = b[k - 1] * (d - k + 1) / k
    }
    return b
}

export class MandelbrotMultibrotPerturbation {
    /**
     * @param {WorkerContext} ctx
     */
    constructor(ctx) {
        this.ctx = ctx
        this.paramHash = null
        this.jobId = null
        this.referencePoints = []
        this.lastZq = 0
    }

    async process(task) {
        this.max_iter = task.maxIter
        this.degree = task.multibrotDegree ?? DEFAULT_DEGREE
        this.logDegree = Math.log(this.degree)
        // The extra |z| < |ε| decorrelation glitch test is only needed at high degree, where the
        // perturbation decorrelates too fast for the Pauldelbrot test. At low degree the standard
        // perturbation is already exact, so enabling it there only wastes references (it would
        // recompute many pixels for no gain). Factor 0 disables the term (zzq < 0 never fires).
        this.decorrFactor = this.degree >= HIGH_DEGREE ? 1 : 0
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

        // Size in the complex plane
        const cWidth = Number(rmax.subtract(rmin).bigInt) / scaleFactor
        const cHeight = Number(imax.subtract(imin).bigInt) / scaleFactor
        const refr = rmin.bigInt
        const refi = imin.bigInt

        this.julia = task.julia === true
        let bailout
        if (this.julia) {
            const seed0 = task.juliaSeed[0].withScale(scale)
            const seed1 = task.juliaSeed[1].withScale(scale)
            this.juliaRFx = seed0.bigInt
            this.juliaIFx = seed1.bigInt
            bailout = Math.max(128, 2 * Math.hypot(seed0.toNumber(), seed1.toNumber()) + 16)
        } else {
            bailout = smooth ? 128 : 4
        }
        const bigBailout = BigInt(Math.ceil(bailout)) << bigScale

        this.updateCache(task, cWidth, cHeight, scaleFactor)

        if (this.referencePoints.length === 0) {
            const x = Math.trunc(w / 2)
            const y = Math.trunc(h / 2)
            const dr = (task.xOffset + x) / task.frameWidth * cWidth
            const di = (task.yOffset + y) / task.frameHeight * cHeight
            this.referencePoints.push(this.calculate_reference(refr, refi, dr, di, bigScale, scaleFactor, bigBailout))
            if (this.ctx.shouldStop()) return
        }

        // Index of the reference the previous pixel used; adjacent pixels almost always share a
        // reference, so trying it first turns the per-pixel reference scan into a single attempt
        // across whole regions. Any non-glitching reference yields the same (correct) value, so the
        // order we try them in does not affect the result, only how many we try.
        let lastRefIndex = 0
        // Reference-scan cap, scaled by precision: a scan attempt is float (scale-independent) but a
        // fallback own orbit is BigInt (cost grows ~scale^1.6), so at high precision it pays to scan
        // many more references before computing one. Calibrated scale-300 -> 16, scale-1000 -> ~110.
        const maxRefScan = this.maxRefScan ?? Math.max(MIN_REFERENCE_SCAN, Math.round(scale * scale / 9000))
        for (let y = 0; y < h; y++) {
            const di = (task.yOffset + y) / task.frameHeight * cHeight
            const skipLeft = skipTopLeft && y % 2 === 0

            for (let x = 0; x < w; x++) {
                if (skipLeft && x % 2 === 0) {
                    // skip
                } else {
                    const dr = (task.xOffset + x) / task.frameWidth * cWidth

                    let found = false
                    const offset = y * w + x

                    const referencePoints = this.referencePoints
                    const numRefs = referencePoints.length

                    // Fast path: try the previous pixel's reference before scanning all of them.
                    if (this.fastReference !== false && lastRefIndex < numRefs) {
                        const iter = this.perturb(referencePoints[lastRefIndex], dr, di, bailout)
                        if (iter >= 0) {
                            values[offset] = this.smoothenDegree(smooth, offset, iter, this.lastZq)
                            found = true
                            stats.numberOfLowPrecisionPoints++
                        } else {
                            stats.numberOfLowPrecisionMisses++
                        }
                    }

                    if (!found) {
                        // Cap the scan: a pixel that glitches against the longest references has no
                        // usable reference and must compute its own exact orbit anyway, so scanning
                        // all of them (hundreds, in chaotic boundary regions) is wasted work. The
                        // result is unchanged — the fallback orbit is exact.
                        let scanned = 0
                        for (let refIndex = 0; refIndex < numRefs; refIndex++) {
                            if (refIndex === lastRefIndex) continue // already tried in the fast path
                            if (scanned++ >= maxRefScan) break
                            const iter = this.perturb(referencePoints[refIndex], dr, di, bailout)
                            if (iter >= 0) {
                                values[offset] = this.smoothenDegree(smooth, offset, iter, this.lastZq)
                                found = true
                                lastRefIndex = refIndex
                                stats.numberOfLowPrecisionPoints++
                                break
                            }
                            stats.numberOfLowPrecisionMisses++
                            if (iter === -2) {
                                break // pixel outlives this (longest remaining) reference
                            }
                        }
                    }

                    if (!found) {
                        const newRef = this.calculate_reference(refr, refi, dr, di, bigScale, scaleFactor, bigBailout)
                        values[offset] = this.smoothenDegree(smooth, offset, newRef[1], Number(newRef[2]) / scaleFactor)
                        let pos = 0
                        while (pos < referencePoints.length && referencePoints[pos][4] >= newRef[4]) {
                            pos++
                        }
                        referencePoints.splice(pos, 0, newRef)
                        lastRefIndex = pos // the new reference is closest to this pixel — try it first next
                        if (this.ctx.shouldStop()) return
                    }
                }
            }
            if (this.ctx.shouldStop()) return
        }
    }

    // One perturbation attempt of a pixel (dr, di) against a reference point; see multibrot_perturbation.
    perturb(referencePoint, dr, di, bailout) {
        const dcr = dr - referencePoint[0][0]
        const dci = di - referencePoint[0][1]
        return this.julia
            ? this.multibrot_perturbation(dcr, dci, 0, 0, this.max_iter, bailout, referencePoint[3], referencePoint[4])
            : this.multibrot_perturbation(dcr, dci, dcr, dci, this.max_iter, bailout, referencePoint[3], referencePoint[4])
    }

    // Like the shared smoothen but with the degree-aware fractional iteration (log d growth)
    smoothenDegree(smooth, offset, iter, zq) {
        if (smooth && iter > 3) {
            let log_zn = Math.log(zq) / 2
            let nu = Math.log(log_zn / Math.log(2)) / this.logDegree
            iter = Math.floor(iter + 1 - nu)
            nu = nu - Math.floor(nu)
            smooth[offset] = Math.floor(255 - 255 * nu)
        }
        return iter
    }

    updateCache(task, cWidth, cHeight, scaleFactor) {
        if (task.jobId !== this.jobId) {
            this.jobId = task.jobId
            if (this.paramHash !== task.paramHash || this.referencePoints.length === 0 || task.resetCaches) {
                this.paramHash = task.paramHash
                this.referencePoints = []
            } else {
                // Keep reference points that are within the total frame when job parameters did not change
                const oldReferencePoints = this.referencePoints
                this.referencePoints = []
                const oldPrecision = this.precision
                const newPrecision = task.precision
                if (newPrecision === oldPrecision) {
                    const deltar = Number(task.frameTopLeft[0].subtract(this.topLeft[0]).bigInt) / scaleFactor
                    const deltai = Number(task.frameTopLeft[1].subtract(this.topLeft[1]).bigInt) / scaleFactor
                    for (let referencePoint of oldReferencePoints) {
                        const dr = referencePoint[0][0] - deltar
                        const di = referencePoint[0][1] - deltai
                        if (dr < cWidth && di < cHeight) {
                            referencePoint[0] = [dr, di]
                            this.referencePoints.push(referencePoint)
                        }
                    }
                }
            }
            this.precision = task.precision
            this.topLeft = task.frameTopLeft
        }
    }

    /**
     * Returns the iteration count (>= 0) with the squared escape radius in this.lastZq.
     * Returns -2 when the reference orbit is too short for this pixel and -1 when precision
     * was lost (glitch), in which case another reference point may still work.
     *
     * @param {Float64Array} zs flattened reference sequence with stride 2d+1:
     *   (X, Y, B₁r, B₁i, ..., B₍d₋₁₎r, B₍d₋₁₎i, zqErrorBound)
     * @returns {number} iter
     */
    multibrot_perturbation(e0r, e0i, adr, adi, max_iter, bailout, zs, numZs) {
        const d = this.degree
        const stride = 2 * d + 1
        // ε₀ = δ (in julia mode the per-step term is zero, δ only enters here)
        let u = e0r
        let v = e0i

        let iter = -1
        let zzq = 0
        while (zzq <= bailout) {
            if (iter++ === max_iter) {
                this.lastZq = 0
                return 2
            }
            if (iter >= numZs) {
                this.lastZq = zzq
                return -2
            }

            // Zₙ
            const base = iter * stride
            const X = zs[base]
            const Y = zs[base + 1]

            // Z'ₙ = Zₙ + εₙ
            const zzr = X + u
            const zzi = Y + v
            zzq = zzr * zzr + zzi * zzi
            if (zzq < zs[base + 2 * d] || zzq < (u * u + v * v) * this.decorrFactor) {
                this.lastZq = 0
                return -1
            }

            // Horner over the binomial-scaled powers, see file header
            let ar = 1
            let ai = 0
            for (let k = d - 1; k >= 1; k--) {
                const br = zs[base + 2 * k]
                const bi = zs[base + 2 * k + 1]
                const t = ar * u - ai * v + br
                ai = ar * v + ai * u + bi
                ar = t
            }
            const _u = ar * u - ai * v + adr
            const _v = ar * v + ai * u + adi
            u = _u
            v = _v
        }
        this.lastZq = zzq
        return iter + 4
    }

    /**
     * @returns {[[number, number], number, BigInt, Float64Array, number]} [rr, ri], iter, zq, zs, numZs
     */
    calculate_reference(refr, refi, dr, di, bigScale, scaleFactor, bailout) {
        const start = performance.now()
        const d = this.degree
        const stride = 2 * d + 1
        const binom = binomials(d)
        const rr = refr + BigInt(Math.round(dr * scaleFactor))
        const ri = refi + BigInt(Math.round(di * scaleFactor))
        const [iter, zq, seq] = this.julia
            ? this.multibrot_high_precision(rr, ri, this.juliaRFx, this.juliaIFx, this.max_iter, bailout, bigScale, true)
            : this.multibrot_high_precision(0n, 0n, rr, ri, this.max_iter, bailout, bigScale, false)
        const iterations = seq.length
        const zs = new Float64Array(iterations * stride)
        for (let idx = 0, base = 0; idx < iterations; idx++, base += stride) {
            const point = seq[idx]
            const x = Number(point[0]) / scaleFactor
            const y = Number(point[1]) / scaleFactor
            zs[base] = x
            zs[base + 1] = y
            // float powers Z^j and the binomial-scaled Bₖ = C(d,k)·Z^(d−k), Bₖ at index pair k
            // (consistent with the float arithmetic of the pixel loop)
            let pwr = x
            let pwi = y
            zs[base + 2 * (d - 1)] = binom[d - 1] * pwr      // B₍d₋₁₎ = C(d,d−1)·Z¹
            zs[base + 2 * (d - 1) + 1] = binom[d - 1] * pwi
            for (let j = 2; j <= d - 1; j++) {
                const t = pwr * x - pwi * y
                pwi = pwr * y + pwi * x
                pwr = t
                const k = d - j  // Bₖ pairs with Z^j
                zs[base + 2 * k] = binom[k] * pwr
                zs[base + 2 * k + 1] = binom[k] * pwi
            }
            zs[base + 2 * d] = (x * x + y * y) * 0.000001
        }
        const end = performance.now()
        this.ctx.stats.timeSpendInHighPrecision += end - start
        this.ctx.stats.numberOfHighPrecisionPoints++
        return [[dr, di], iter, zq, zs, iterations]
    }

    /**
     * @returns {[number, BigInt, [BigInt, BigInt][]]} [iterations, zq, sequence]
     */
    multibrot_high_precision(z0r, z0i, addr, addi, max_iter, bailout, scale, includeZ0) {
        const d = this.degree
        // z^d by binary exponentiation: a complex square needs only 2 BigInt mults and a complex
        // multiply 3 (Gauss), vs 4 per step for the naive (d−1)-multiply chain. For d=8 this is
        // 3 squarings (6 mults) instead of 7 multiplies (28) — ~3.3x fewer BigInt multiplies.
        // powSteps[s] = true means "multiply by z after squaring" (the s-th bit of d below the top).
        if (!this.powSteps || this.powStepsDegree !== d) {
            this.powSteps = []
            const bits = d.toString(2)
            for (let i = 1; i < bits.length; i++) this.powSteps.push(bits[i] === '1')
            this.powStepsDegree = d
        }
        const steps = this.powSteps, nSteps = steps.length
        let zr = z0r
        let zi = z0i
        let iter = -1
        let zq = includeZ0 ? ((zr * zr) >> scale) + ((zi * zi) >> scale) : 0n
        const seq = []
        if (includeZ0) {
            seq.push([zr, zi])
        }
        while (zq <= bailout) {
            if (iter++ === max_iter) {
                return [2, 0n, seq]
            }
            let rr = zr, ri = zi
            for (let s = 0; s < nSteps; s++) {
                const sre = ((rr + ri) * (rr - ri)) >> scale // rr² − ri²
                ri = ((rr * ri) << 1n) >> scale               // 2·rr·ri
                rr = sre
                if (steps[s]) {                               // × z (Gauss: 3 mults)
                    const t1 = rr * zr, t2 = ri * zi, t3 = (rr + ri) * (zr + zi)
                    rr = (t1 - t2) >> scale
                    ri = (t3 - t1 - t2) >> scale
                }
            }
            zr = rr + addr
            zi = ri + addi
            seq.push([zr, zi])
            zq = ((zr * zr) >> scale) + ((zi * zi) >> scale)
        }
        // one more point so that pixels escaping just after the reference still have orbit data
        let rr = zr, ri = zi
        for (let s = 0; s < nSteps; s++) {
            const sre = ((rr + ri) * (rr - ri)) >> scale
            ri = ((rr * ri) << 1n) >> scale
            rr = sre
            if (steps[s]) {
                const t1 = rr * zr, t2 = ri * zi, t3 = (rr + ri) * (zr + zi)
                rr = (t1 - t2) >> scale
                ri = (t3 - t1 - t2) >> scale
            }
        }
        seq.push([rr + addr, ri + addi])
        return [includeZ0 ? iter + 5 : iter + 4, zq, seq]
    }
}
