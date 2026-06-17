/**
 * Perturbation version of the abs-variant family (see mandelbrotAbsFamily.js) for deep zoom
 * up to about 1e300. Every absolute value perturbs exactly with diffabs case analysis:
 *
 *   real part:  A = abs:  |x²−y²| − |X²−Y²| = diffabs(X²−Y², 2Xu+u²−2Yv−v²)
 *               A = id:   2Xu+u² − 2Yv−v²
 *   imag part (the difference F(x)G(y) − F(X)G(Y) for the four F/G combinations):
 *     id·id:    X·v + u·(Y+v)
 *     abs·abs:  diffabs(X·Y, X·v + u·(Y+v))
 *     abs·id:   |X+u|·v + diffabs(X, u)·Y
 *     id·abs:   u·|Y+v| + X·diffabs(Y, v)
 *
 * All branches return quantities with a small factor, so there is no catastrophic
 * cancellation. The reference sequence stores (X, Y, X·Y, X²−Y², errorBound) per point.
 * Uses the same longest-orbit-first reference machinery as the other perturbation engines.
 */
import {WorkerContext, smoothen} from "./workerContext.js";
import {ABS_VARIANTS, DEFAULT_VARIANT} from "./mandelbrotAbsFamily.js";

// |c + d| − |c|, exact in all sign combinations
function diffabs(c, d) {
    if (c >= 0) {
        return c + d >= 0 ? d : -d - 2 * c
    }
    return c + d > 0 ? d + 2 * c : -d
}

export class MandelbrotAbsFamilyPerturbation {
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
        const variant = ABS_VARIANTS[task.absVariant] ?? ABS_VARIANTS[DEFAULT_VARIANT]
        this.absRe = variant.absRe
        this.absX = variant.absX
        this.absY = variant.absY
        this.sign2 = 2 * variant.sign
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
                    for (let refIndex = 0; refIndex < numRefs; refIndex++) {
                        const referencePoint = referencePoints[refIndex]
                        const refDr = referencePoint[0][0]
                        const refDi = referencePoint[0][1]

                        const dcr = dr - refDr
                        const dci = di - refDi
                        const iter = this.julia
                            ? this.abs_family_perturbation(dcr, dci, 0, 0, this.max_iter, bailout, referencePoint[3], referencePoint[4])
                            : this.abs_family_perturbation(dcr, dci, dcr, dci, this.max_iter, bailout, referencePoint[3], referencePoint[4])
                        if (iter >= 0) {
                            values[offset] = smoothen(smooth, offset, iter, this.lastZq)
                            found = true
                            stats.numberOfLowPrecisionPoints++
                            break
                        }
                        stats.numberOfLowPrecisionMisses++
                        if (iter === -2) {
                            break // pixel outlives this (longest remaining) reference
                        }
                    }

                    if (!found) {
                        const newRef = this.calculate_reference(refr, refi, dr, di, bigScale, scaleFactor, bigBailout)
                        values[offset] = smoothen(smooth, offset, newRef[1], Number(newRef[2]) / scaleFactor)
                        const referencePoints = this.referencePoints
                        let pos = 0
                        while (pos < referencePoints.length && referencePoints[pos][4] >= newRef[4]) {
                            pos++
                        }
                        referencePoints.splice(pos, 0, newRef)
                        if (this.ctx.shouldStop()) return
                    }
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
     * @param {Float64Array} zs flattened reference sequence with stride 5: (X, Y, X·Y, X²−Y², zqErrorBound)
     * @returns {number} iter
     */
    abs_family_perturbation(e0r, e0i, adr, adi, max_iter, bailout, zs, numZs) {
        const absRe = this.absRe
        const absX = this.absX
        const absY = this.absY
        const sign2 = this.sign2
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
            const base = iter * 5
            const X = zs[base]
            const Y = zs[base + 1]

            // Z'ₙ = Zₙ + εₙ
            const zzr = X + u
            const zzi = Y + v
            zzq = zzr * zzr + zzi * zzi
            if (zzq < zs[base + 4]) {
                this.lastZq = 0
                return -1
            }

            // see file header for the diffabs expansions
            const sq = (X + zzr) * u - (Y + zzi) * v  // 2Xu+u² − 2Yv−v²
            const er = absRe ? diffabs(zs[base + 3], sq) : sq
            let imDiff
            if (absX) {
                if (absY) {
                    imDiff = diffabs(zs[base + 2], X * v + u * zzi)
                } else {
                    imDiff = Math.abs(zzr) * v + diffabs(X, u) * Y
                }
            } else if (absY) {
                imDiff = u * Math.abs(zzi) + X * diffabs(Y, v)
            } else {
                imDiff = X * v + u * zzi
            }
            u = er + adr
            v = sign2 * imDiff + adi
        }
        this.lastZq = zzq
        return iter + 4
    }

    /**
     * @returns {[[number, number], number, BigInt, Float64Array, number]} [rr, ri], iter, zq, zs, numZs
     */
    calculate_reference(refr, refi, dr, di, bigScale, scaleFactor, bailout) {
        const start = performance.now()
        const rr = refr + BigInt(Math.round(dr * scaleFactor))
        const ri = refi + BigInt(Math.round(di * scaleFactor))
        const [iter, zq, seq] = this.julia
            ? this.abs_family_high_precision(rr, ri, this.juliaRFx, this.juliaIFx, this.max_iter, bailout, bigScale, true)
            : this.abs_family_high_precision(0n, 0n, rr, ri, this.max_iter, bailout, bigScale, false)
        const iterations = seq.length
        const zs = new Float64Array(iterations * 5)
        for (let idx = 0, base = 0; idx < iterations; idx++, base += 5) {
            const point = seq[idx]
            const x = Number(point[0]) / scaleFactor
            const y = Number(point[1]) / scaleFactor
            zs[base] = x
            zs[base + 1] = y
            zs[base + 2] = x * y
            zs[base + 3] = x * x - y * y
            zs[base + 4] = (x * x + y * y) * 0.000001
        }
        const end = performance.now()
        this.ctx.stats.timeSpendInHighPrecision += end - start
        this.ctx.stats.numberOfHighPrecisionPoints++
        return [[dr, di], iter, zq, zs, iterations]
    }

    /**
     * @returns {[number, BigInt, [BigInt, BigInt][]]} [iterations, zq, sequence]
     */
    abs_family_high_precision(z0r, z0i, addr, addi, max_iter, bailout, scale, includeZ0) {
        const scale_1 = scale - 1n
        const absRe = this.absRe
        const absX = this.absX
        const absY = this.absY
        const negate = this.sign2 < 0
        let zr = z0r
        let zi = z0i
        let iter = -1
        let zrq = (zr * zr) >> scale
        let ziq = (zi * zi) >> scale
        let zq = includeZ0 ? zrq + ziq : 0n
        const seq = []
        if (includeZ0) {
            seq.push([zr, zi])
        }
        while (zq <= bailout) {
            if (iter++ === max_iter) {
                return [2, 0n, seq]
            }
            const a = absX && zr < 0n ? -zr : zr
            const b = absY && zi < 0n ? -zi : zi
            let p = (a * b) >> scale_1
            if (negate) p = -p
            let t = zrq - ziq
            if (absRe && t < 0n) t = -t
            zi = p + addi
            zr = t + addr
            seq.push([zr, zi])
            zrq = (zr * zr) >> scale
            ziq = (zi * zi) >> scale
            zq = zrq + ziq
        }
        const a = absX && zr < 0n ? -zr : zr
        const b = absY && zi < 0n ? -zi : zi
        let p = (a * b) >> scale_1
        if (negate) p = -p
        let t = zrq - ziq
        if (absRe && t < 0n) t = -t
        seq.push([t + addr, p + addi])
        return [includeZ0 ? iter + 5 : iter + 4, zq, seq]
    }
}
