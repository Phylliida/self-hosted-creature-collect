/**
 * Perturbation version of the gyre iteration (see mandelbrotGyre.js) for deep zoom up to
 * about 1e300. With the reference orbit Z, the perturbed point z = Z + ε and per-point
 *
 *   Q = 1 + X² + Y²,   S = β/Q,   M = 1 + S·k,   k = e^{iθ} − 1
 *
 * the blend multiplier difference is exact: m − M = k·(s − S) = −k·β·q / (Q·(Q+q)) =: κ with
 * q = 2Xu + 2Yv + u² + v², so the perturbation expands cancellation-free as
 *
 *   εₙ₊₁ = M²·(2Z+ε)·ε + κ·(m+M)·(Z+ε)² + δ
 *
 * (from m²z² − M²Z² = M²(z²−Z²) + (m−M)(m+M)z²). For θ = 0, κ = 0 and M = 1 reduce this to
 * the classic Mandelbrot recurrence. The reference sequence stores (X, Y, Q, errorBound).
 * Uses the same longest-orbit-first reference machinery as the other perturbation engines.
 */
import {WorkerContext, smoothen} from "./workerContext.js";
import * as fxp from "./fxp.js";
import {DEFAULT_THETA, DEFAULT_BETA, gyreBailout} from "./mandelbrotGyre.js";

export class MandelbrotGyrePerturbation {
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
        const theta = (task.gyreTheta ?? DEFAULT_THETA) * Math.PI / 180
        this.beta = task.gyreBeta ?? DEFAULT_BETA
        this.kr = Math.cos(theta) - 1
        this.ki = Math.sin(theta)
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
            bailout = gyreBailout(this.beta, Math.hypot(seed0.toNumber(), seed1.toNumber()))
        } else {
            const cMax = Math.hypot(
                Math.max(Math.abs(rmin.toNumber()), Math.abs(rmax.toNumber())),
                Math.max(Math.abs(imin.toNumber()), Math.abs(imax.toNumber())))
            bailout = gyreBailout(this.beta, cMax)
        }
        this.bailout = bailout
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
                            ? this.gyre_perturbation(dcr, dci, 0, 0, this.max_iter, bailout, referencePoint[3], referencePoint[4])
                            : this.gyre_perturbation(dcr, dci, dcr, dci, this.max_iter, bailout, referencePoint[3], referencePoint[4])
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
     * @param {Float64Array} zs flattened reference sequence with stride 4: (X, Y, Q, zqErrorBound)
     * @returns {number} iter
     */
    gyre_perturbation(e0r, e0i, adr, adi, max_iter, bailout, zs, numZs) {
        const beta = this.beta
        const kr = this.kr
        const ki = this.ki
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
            const base = iter * 4
            const X = zs[base]
            const Y = zs[base + 1]
            const Q = zs[base + 2]

            // Z'ₙ = Zₙ + εₙ
            const zzr = X + u
            const zzi = Y + v
            zzq = zzr * zzr + zzi * zzi
            if (zzq < zs[base + 3]) {
                this.lastZq = 0
                return -1
            }

            // see file header for the derivation
            const S = beta / Q
            const Mr = 1 + S * kr
            const Mi = S * ki
            const p1 = (X + zzr) * u
            const p2 = (Y + zzi) * v
            const q = p1 + p2
            const t = -beta * q / (Q * (Q + q))  // s − S
            const kapr = t * kr
            const kapi = t * ki
            // A = (2Z+ε)·ε
            const ar = p1 - p2
            const ai = (X + zzr) * v + (Y + zzi) * u
            // B = M²·A
            const m2r = Mr * Mr - Mi * Mi
            const m2i = 2 * Mr * Mi
            const br = m2r * ar - m2i * ai
            const bi = m2r * ai + m2i * ar
            // D = κ·(m+M)·(Z+ε)²
            const sr = 2 * Mr + kapr
            const si = 2 * Mi + kapi
            const er = kapr * sr - kapi * si
            const ei = kapr * si + kapi * sr
            const cr2 = zzr * zzr - zzi * zzi
            const ci2 = 2 * zzr * zzi
            const dr_ = er * cr2 - ei * ci2
            const di_ = er * ci2 + ei * cr2
            u = br + dr_ + adr
            v = bi + di_ + adi
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
            ? this.gyre_high_precision(rr, ri, this.juliaRFx, this.juliaIFx, this.max_iter, bailout, bigScale, true)
            : this.gyre_high_precision(0n, 0n, rr, ri, this.max_iter, bailout, bigScale, false)
        const iterations = seq.length
        const zs = new Float64Array(iterations * 4)
        for (let idx = 0, base = 0; idx < iterations; idx++, base += 4) {
            const point = seq[idx]
            const x = Number(point[0]) / scaleFactor
            const y = Number(point[1]) / scaleFactor
            const zq2 = x * x + y * y
            zs[base] = x
            zs[base + 1] = y
            zs[base + 2] = 1 + zq2
            zs[base + 3] = zq2 * 0.000001
        }
        const end = performance.now()
        this.ctx.stats.timeSpendInHighPrecision += end - start
        this.ctx.stats.numberOfHighPrecisionPoints++
        return [[dr, di], iter, zq, zs, iterations]
    }

    /**
     * @returns {[number, BigInt, [BigInt, BigInt][]]} [iterations, zq, sequence]
     */
    gyre_high_precision(z0r, z0i, addr, addi, max_iter, bailout, scale, includeZ0) {
        const one = 1n << scale
        const betaShifted = fxp.fromNumber(this.beta, Number(scale)).bigInt << scale
        const krFx = fxp.fromNumber(this.kr, Number(scale)).bigInt
        const kiFx = fxp.fromNumber(this.ki, Number(scale)).bigInt
        let X = z0r
        let Y = z0i
        let iter = -1
        let Xq = (X * X) >> scale
        let Yq = (Y * Y) >> scale
        let zq = includeZ0 ? Xq + Yq : 0n
        const seq = []
        if (includeZ0) {
            seq.push([X, Y])
        }
        while (zq <= bailout) {
            if (iter++ === max_iter) {
                return [2, 0n, seq]
            }
            const Q = one + Xq + Yq
            const S = betaShifted / Q
            const Mr = one + ((S * krFx) >> scale)
            const Mi = (S * kiFx) >> scale
            const wr = (X * Mr - Y * Mi) >> scale
            const wi = (X * Mi + Y * Mr) >> scale
            const nX = ((wr * wr - wi * wi) >> scale) + addr
            const nY = ((wr * wi) >> (scale - 1n)) + addi
            X = nX
            Y = nY
            seq.push([X, Y])
            Xq = (X * X) >> scale
            Yq = (Y * Y) >> scale
            zq = Xq + Yq
        }
        // one more point so that pixels escaping just after the reference still have orbit data
        const Q = one + Xq + Yq
        const S = betaShifted / Q
        const Mr = one + ((S * krFx) >> scale)
        const Mi = (S * kiFx) >> scale
        const wr = (X * Mr - Y * Mi) >> scale
        const wi = (X * Mi + Y * Mr) >> scale
        seq.push([((wr * wr - wi * wi) >> scale) + addr, ((wr * wi) >> (scale - 1n)) + addi])
        return [includeZ0 ? iter + 5 : iter + 4, zq, seq]
    }
}
