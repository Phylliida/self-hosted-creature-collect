/**
 * Perturbation version of the tricorn iteration zₙ₊₁ = conj(zₙ)² + c for deep zoom up to
 * about 1e300. The map is anti-holomorphic, so with z = Z + ε the perturbation is simply the
 * conjugated Mandelbrot recurrence:
 *
 *   εₙ₊₁ = conj((2·Zₙ + εₙ)·εₙ) + δ
 *
 * which is exact and cancellation-free. Uses the same reference point machinery as the mirage
 * perturbation: references are tried longest-orbit-first to avoid the escape-time selection
 * bias chaotic regions would otherwise introduce.
 */
import {WorkerContext, smoothen} from "./workerContext.js";

export class MandelbrotTricornPerturbation {
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
                            ? this.tricorn_perturbation(dcr, dci, 0, 0, this.max_iter, bailout, referencePoint[3], referencePoint[4])
                            : this.tricorn_perturbation(dcr, dci, dcr, dci, this.max_iter, bailout, referencePoint[3], referencePoint[4])
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
     * @param {number} dcr
     * @param {number} dci
     * @param {number} max_iter
     * @param {number} bailout
     * @param {Float64Array} zs flattened reference sequence with stride 3: (X, Y, zqErrorBound)
     * @param {number} numZs number of points in zs
     * @returns {number} iter
     */
    tricorn_perturbation(e0r, e0i, adr, adi, max_iter, bailout, zs, numZs) {
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
            const base = iter * 3
            const X = zs[base]
            const Y = zs[base + 1]

            // Z'ₙ = Zₙ + εₙ
            const zzr = X + u
            const zzi = Y + v
            zzq = zzr * zzr + zzi * zzi
            if (zzq < zs[base + 2]) {
                this.lastZq = 0
                return -1
            }

            // εₙ₊₁ = conj((2·Zₙ + εₙ)·εₙ) + δ
            const _u = (X + zzr) * u - (Y + zzi) * v + adr
            const _v = -2 * (X * v + u * zzi) + adi
            u = _u
            v = _v
        }
        this.lastZq = zzq
        return iter + 4
    }

    /**
     * @returns {[[number, number], number, BigInt, Float64Array, number]} [rr, ri], iter, zq, zs, numZs where zs
     * is the flattened reference sequence with stride 3: (X, Y, zqErrorBound)
     */
    calculate_reference(refr, refi, dr, di, bigScale, scaleFactor, bailout) {
        const start = performance.now()
        const rr = refr + BigInt(Math.round(dr * scaleFactor))
        const ri = refi + BigInt(Math.round(di * scaleFactor))
        const [iter, zq, seq] = this.julia
            ? this.tricorn_high_precision(rr, ri, this.juliaRFx, this.juliaIFx, this.max_iter, bailout, bigScale, true)
            : this.tricorn_high_precision(0n, 0n, rr, ri, this.max_iter, bailout, bigScale, false)
        const iterations = seq.length
        const zs = new Float64Array(iterations * 3)
        for (let idx = 0, base = 0; idx < iterations; idx++, base += 3) {
            const point = seq[idx]
            const x = Number(point[0]) / scaleFactor
            const y = Number(point[1]) / scaleFactor
            zs[base] = x
            zs[base + 1] = y
            zs[base + 2] = (x * x + y * y) * 0.000001
        }
        const end = performance.now()
        this.ctx.stats.timeSpendInHighPrecision += end - start
        this.ctx.stats.numberOfHighPrecisionPoints++
        return [[dr, di], iter, zq, zs, iterations]
    }

    /**
     * @returns {[number, BigInt, [BigInt, BigInt][]]} [iterations, zq, sequence]
     */
    tricorn_high_precision(z0r, z0i, addr, addi, max_iter, bailout, scale, includeZ0) {
        const scale_1 = scale - 1n
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
            zi = -(zr * zi >> scale_1) + addi
            zr = zrq - ziq + addr
            seq.push([zr, zi])
            zrq = (zr * zr) >> scale
            ziq = (zi * zi) >> scale
            zq = zrq + ziq
        }
        zi = -(zr * zi >> scale_1) + addi
        zr = zrq - ziq + addr
        seq.push([zr, zi])
        return [includeZ0 ? iter + 5 : iter + 4, zq, seq]
    }
}
