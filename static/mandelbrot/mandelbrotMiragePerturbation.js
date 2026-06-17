/**
 * Perturbation version of the mirage iteration (see mandelbrotMirage.js), enabling deep zoom
 * beyond the float64 limit of about 1e13, up to about 1e300. Modeled on MandelbrotPerturbation.
 *
 * The mirage map is not complex-analytic (it mixes in the conjugate and the |z|² dependent
 * blend factor), but it can still be perturbed exactly. With the reference orbit Z = (X, Y),
 * the perturbed point z = Z + ε, ε = (u, v) and per-orbit-point values
 *
 *   Q = 1 + X² + Y²,  S = β/Q,  T = 1 − 2S
 *
 * the perturbation of the blend factor follows from q = 2Xu + 2Yv + u² + v² (the perturbation
 * of 1 + |z|²) as
 *
 *   τ = t − T = 2β·q / (Q·(Q + q))
 *
 * and the exact difference of the squared mirrored values w² − W² expands cancellation-free to
 *
 *   (w² − W²)ᵣ = (2X+u)·u − T²·(2Y+v)·v − (2T+τ)·τ·(Y+v)²
 *   (w² − W²)ᵢ = 2·( X·(T·v + τ·(Y+v)) + u·(T+τ)·(Y+v) )
 *
 * giving εₙ₊₁ = (1−α)·εₙ + α·((w² − W²) + δ). For β = 0 (τ = 0, T = 1) this reduces exactly to
 * the classic Mandelbrot perturbation εₙ₊₁ = (2·Zₙ + εₙ)·εₙ + δ, as it should.
 */
import {WorkerContext, smoothen} from "./workerContext.js";
import * as fxp from "./fxp.js";
import {DEFAULT_ALPHA, DEFAULT_BETA, bailoutFor} from "./mandelbrotMirage.js";

export class MandelbrotMiragePerturbation {
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
        this.alpha = task.mirageAlpha ?? DEFAULT_ALPHA
        this.beta = task.mirageBeta ?? DEFAULT_BETA
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
            // in julia mode the fixed seed is the only c that occurs
            bailout = bailoutFor(this.alpha, this.beta, Math.hypot(seed0.toNumber(), seed1.toNumber()))
        } else {
            const cMax = Math.hypot(
                Math.max(Math.abs(rmin.toNumber()), Math.abs(rmax.toNumber())),
                Math.max(Math.abs(imin.toNumber()), Math.abs(imax.toNumber())))
            bailout = bailoutFor(this.alpha, this.beta, cMax)
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

        // The mirage iteration can be strongly chaotic, so reconstructing the same pixel from
        // different reference points gives noticeably different escape iterations. Retrying
        // until some reference "works" would select for early escapes and visibly bias the
        // image. Instead the references are kept sorted by orbit length and tried longest
        // first: when the pixel outlives the longest reference a shorter one can never
        // legitimately complete it, so an exact reference is computed for the pixel instead.
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
                        // in mirage mode the first step turns z₀ = 0 into α·c, so ε starts at α·δ
                        // which is also the per-step additive term. In julia mode z₀ is the pixel
                        // itself, so ε starts at δ and nothing is re-added.
                        const iter = this.julia
                            ? this.mirage_perturbation(dcr, dci, 0, 0, this.max_iter, bailout, referencePoint[3], referencePoint[4])
                            : this.mirage_perturbation(this.alpha * dcr, this.alpha * dci, this.alpha * dcr, this.alpha * dci, this.max_iter, bailout, referencePoint[3], referencePoint[4])
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
     * @param {Float64Array} zs flattened reference sequence with stride 5: (X, Y, T, Q, zqErrorBound)
     * @param {number} numZs number of points in zs
     * @returns {number} iter
     */
    mirage_perturbation(e0r, e0i, adr, adi, max_iter, bailout, zs, numZs) {
        const alpha = this.alpha
        const a1 = 1 - alpha
        const beta2 = 2 * this.beta
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
            const T = zs[base + 2]
            const Q = zs[base + 3]

            // Z'ₙ = Zₙ + εₙ
            const zzr = X + u
            const zzi = Y + v
            zzq = zzr * zzr + zzi * zzi
            if (zzq < zs[base + 4]) {
                this.lastZq = 0
                return -1
            }

            // εₙ₊₁ = (1−α)·εₙ + α·((w² − W²) + δ), see file header
            const p1 = (X + zzr) * u  // (2X + u)·u
            const p2 = (Y + zzi) * v  // (2Y + v)·v
            const q = p1 + p2
            const tau = beta2 * q / (Q * (Q + q))
            const yv = zzi  // Y + v
            const wqr = p1 - T * T * p2 - (2 * T + tau) * tau * yv * yv
            const wqi = 2 * (X * (T * v + tau * yv) + u * (T + tau) * yv)
            u = a1 * u + alpha * wqr + adr
            v = a1 * v + alpha * wqi + adi
        }
        this.lastZq = zzq
        return iter + 4
    }

    /**
     * @param {BigInt} refr
     * @param {BigInt} refi
     * @param {number} dr
     * @param {number} di
     * @param {BigInt} bigScale
     * @param {number} scaleFactor
     * @param {BigInt} bailout
     * @returns {[[number, number], number, BigInt, Float64Array, number]} [rr, ri], iter, zq, zs, numZs where zs
     * is the flattened reference sequence with stride 5: (X, Y, T, Q, zqErrorBound)
     */
    calculate_reference(refr, refi, dr, di, bigScale, scaleFactor, bailout) {
        const start = performance.now()
        const rr = refr + BigInt(Math.round(dr * scaleFactor))
        const ri = refi + BigInt(Math.round(di * scaleFactor))
        const [iter, zq, seq] = this.julia
            ? this.mirage_high_precision(rr, ri, this.juliaRFx, this.juliaIFx, this.max_iter, bailout, bigScale, true)
            : this.mirage_high_precision(0n, 0n, rr, ri, this.max_iter, bailout, bigScale, false)
        const beta2 = 2 * this.beta
        const iterations = seq.length
        const zs = new Float64Array(iterations * 5)
        for (let idx = 0, base = 0; idx < iterations; idx++, base += 5) {
            const point = seq[idx]
            const x = Number(point[0]) / scaleFactor
            const y = Number(point[1]) / scaleFactor
            const zq2 = x * x + y * y
            const q = 1 + zq2
            zs[base] = x
            zs[base + 1] = y
            zs[base + 2] = 1 - beta2 / q  // T = 1 − 2β/Q
            zs[base + 3] = q
            zs[base + 4] = zq2 * 0.000001
        }
        const end = performance.now()
        this.ctx.stats.timeSpendInHighPrecision += end - start
        this.ctx.stats.numberOfHighPrecisionPoints++
        return [[dr, di], iter, zq, zs, iterations]
    }

    /**
     * The mirage iteration in fixed-point arithmetic. α and β (float64 values) are represented
     * exactly in fixed point, the blend s = β/(1+|z|²) needs one fixed-point division per iteration.
     *
     * @param {BigInt} re
     * @param {BigInt} im
     * @param {number} max_iter
     * @param {BigInt} bailout
     * @param {BigInt} scale
     * @returns {[number, BigInt, [BigInt, BigInt][]]} [iterations, zq, sequence] where sequence is a list of [X, Y] points
     */
    mirage_high_precision(z0r, z0i, addr, addi, max_iter, bailout, scale, includeZ0) {
        const one = 1n << scale
        const alphaFx = fxp.fromNumber(this.alpha, Number(scale)).bigInt
        const a1Fx = one - alphaFx
        const betaShifted = fxp.fromNumber(this.beta, Number(scale)).bigInt << scale
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
            const s = betaShifted / Q
            const T = one - (s << 1n)
            const TY = (T * Y) >> scale
            const XTY = (X * TY) >> scale
            const TYq = (TY * TY) >> scale
            const nX = (a1Fx * X + alphaFx * (Xq - TYq + addr)) >> scale
            const nY = (a1Fx * Y + alphaFx * ((XTY << 1n) + addi)) >> scale
            X = nX
            Y = nY
            seq.push([X, Y])
            Xq = (X * X) >> scale
            Yq = (Y * Y) >> scale
            zq = Xq + Yq
        }
        // one more point so that pixels escaping just after the reference still have orbit data
        const Q = one + Xq + Yq
        const s = betaShifted / Q
        const T = one - (s << 1n)
        const TY = (T * Y) >> scale
        const XTY = (X * TY) >> scale
        const TYq = (TY * TY) >> scale
        const nX = (a1Fx * X + alphaFx * (Xq - TYq + addr)) >> scale
        const nY = (a1Fx * Y + alphaFx * ((XTY << 1n) + addi)) >> scale
        seq.push([nX, nY])
        return [includeZ0 ? iter + 5 : iter + 4, zq, seq]
    }
}
