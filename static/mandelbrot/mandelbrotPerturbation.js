/**
 * @author Bert Baron
 */
import {WorkerContext, smoothen} from "./workerContext.js";

export class MandelbrotPerturbation {
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

    async process(task){
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

        // We queue reference points in LRU order, the head pointing to the least recently successfully used reference point
        let head = this.referencePoints.length - 1
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
                    let refIndex = head
                    for (let attempt = 0; attempt < numRefs; attempt++) {
                        let referencePoint = referencePoints[refIndex]
                        const refDr = referencePoint[0][0]
                        const refDi = referencePoint[0][1]

                        const dcr = dr - refDr
                        const dci = di - refDi
                        const iter = this.julia
                            ? this.mandlebrot_perturbation(dcr, dci, 0, 0, this.max_iter, bailout, referencePoint[3], referencePoint[4])
                            : this.mandlebrot_perturbation(dcr, dci, dcr, dci, this.max_iter, bailout, referencePoint[3], referencePoint[4])
                        if (iter >= 0) {
                            values[offset] = smoothen(smooth, offset, iter, this.lastZq)
                            found = true
                            stats.numberOfLowPrecisionPoints++
                            if (refIndex < head) {
                                head--
                                referencePoints[refIndex] = referencePoints[head]
                                referencePoints[head] = referencePoint
                            } else if (refIndex > head) {
                                for (let i = refIndex; i > head; i--) {
                                    referencePoints[i] = referencePoints[i - 1]
                                }
                                referencePoints[head] = referencePoint
                            }
                            break
                        }
                        stats.numberOfLowPrecisionMisses++
                        refIndex = (refIndex + 1) % numRefs
                    }

                    if (!found) {
                        const newRef = this.calculate_reference(refr, refi, dr, di, bigScale, scaleFactor, bigBailout)
                        values[offset] = smoothen(smooth, offset, newRef[1], Number(newRef[2]) / scaleFactor)
                        this.referencePoints.unshift(newRef)
                        this.referencePoints[0] = this.referencePoints[head]
                        this.referencePoints[head] = newRef
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
     * Returns the iteration count (>= 0) with the squared escape radius in this.lastZq, or a negative
     * number when the calculation could not be completed with this reference point.
     *
     * @param {number} e0r initial perturbation (the pixel delta in both modes)
     * @param {number} e0i
     * @param {number} adr additive per-step term (the pixel delta in mandelbrot mode, 0 in julia mode)
     * @param {number} adi
     * @param {number} max_iter
     * @param {number} bailout
     * @param {Float64Array} zs flattened reference sequence with stride 3: (zr, zi, zqErrorBound)
     * @param {number} numZs number of points in zs
     * @returns {number} iter
     */
    mandlebrot_perturbation(e0r, e0i, adr, adi, max_iter, bailout, zs, numZs) {
        // ε₀ = δ
        let ezr = e0r
        let ezi = e0i

        let iter = -1
        let zzq = 0
        while (zzq <= bailout) {
            if (iter++ === max_iter) {
                this.lastZq = 0
                return 2
            }
            if (iter >= numZs) {
                this.lastZq = zzq
                return -1
            }

            // Zₙ
            const base = iter * 3
            const zr = zs[base]
            const zi = zs[base + 1]
            const zqErrorBound = zs[base + 2]

            // Z'ₙ = Zₙ + εₙ
            const zzr = zr + ezr
            const zzi = zi + ezi
            zzq = zzr * zzr + zzi * zzi
            if (zzq < zqErrorBound) {
                this.lastZq = 0
                return -1
            }

            // εₙ₊₁ = 2·zₙ·εₙ + εₙ² + δ = (2·zₙ + εₙ)·εₙ + δ
            const zr_ezr_2 = zr + zzr
            const zi_ezi_2 = zi + zzi
            const _ezr = zr_ezr_2 * ezr - zi_ezi_2 * ezi
            const _ezi = zr_ezr_2 * ezi + zi_ezi_2 * ezr
            ezr = _ezr + adr
            ezi = _ezi + adi
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
     * is the flattened reference sequence with stride 3: (zr, zi, zqErrorBound)
     */
    calculate_reference(refr, refi, dr, di, bigScale, scaleFactor, bailout) {
        const start = performance.now()
        const rr = refr + BigInt(Math.round(dr * scaleFactor))
        const ri = refi + BigInt(Math.round(di * scaleFactor))
        const [iter, zq, seq] = this.julia
            ? this.mandelbrot_high_precision(rr, ri, this.juliaRFx, this.juliaIFx, this.max_iter, bailout, bigScale, true)
            : this.mandelbrot_high_precision(0n, 0n, rr, ri, this.max_iter, bailout, bigScale, false)
        const iterations = seq.length
        const zs = new Float64Array(iterations * 3)
        for (let idx = 0, base = 0; idx < iterations; idx++, base += 3) {
            const point = seq[idx]
            const z_real = Number(point[0]) / scaleFactor
            const z_imag = Number(point[1]) / scaleFactor
            zs[base] = z_real
            zs[base + 1] = z_imag
            zs[base + 2] = (z_real * z_real + z_imag * z_imag) * 0.000001
        }
        const end = performance.now()
        this.ctx.stats.timeSpendInHighPrecision += end - start
        this.ctx.stats.numberOfHighPrecisionPoints++
        return [[dr, di], iter, zq, zs, iterations]
    }

    /**
     * Iterates from z₀ = (z0r, z0i) with the fixed additive constant (addr, addi). Mandelbrot
     * mode passes z₀ = 0 with the pixel as constant, julia mode passes the pixel as z₀ with
     * the seed as constant and includes z₀ as the first sequence entry.
     *
     * @returns {[number, BigInt, [BigInt, BigInt][]]} [iterations, zq, sequence] where sequence is a list of [zr, zi] points
     */
    mandelbrot_high_precision(z0r, z0i, addr, addi, max_iter, bailout, scale, includeZ0) {
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
            zi = (zr * zi >> scale_1) + addi
            zr = zrq - ziq + addr
            seq.push([zr, zi])
            zrq = (zr * zr) >> scale
            ziq = (zi * zi) >> scale
            zq = zrq + ziq
        }
        zi = (zr * zi >> scale_1) + addi
        zr = zrq - ziq + addr
        seq.push([zr, zi])
        return [includeZ0 ? iter + 5 : iter + 4, zq, seq]
    }
}
