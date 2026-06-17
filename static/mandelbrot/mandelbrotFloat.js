/**
 * @author Bert Baron
 */
import {WorkerContext} from "./workerContext.js";

/**
 * Implementation of the Mandelbrot algorithm using (floating point) numbers.
 * Fast, but works with a precision up to about 58 bits
 */
export class MandelbrotFloat {
    /**
     * @param {WorkerContext} ctx the context for the worker
     */
    constructor(ctx) {
        this.ctx = ctx
        this.lastZq = 0
    }

    async process(task) {
        this.max_iter = task.maxIter
        this.julia = task.julia === true
        if (this.julia) {
            this.juliaR = task.juliaSeed[0].toNumber()
            this.juliaI = task.juliaSeed[1].toNumber()
            // |z|² − |z| must outgrow |c| at the escape radius, the margin covers any reachable seed
            this.juliaBailout = Math.max(128, 2 * Math.hypot(this.juliaR, this.juliaI) + 16)
        }
        const w = task.w
        const h = task.h

        const frameTopLeftFloat = task.frameTopLeft.map(fixed => fixed.toNumber())
        const frameBottomRightFloat = task.frameBottomRight.map(fixed => fixed.toNumber())
        const topLeftFloat = [
            frameTopLeftFloat[0] + task.xOffset * (frameBottomRightFloat[0] - frameTopLeftFloat[0]) / task.frameWidth,
            frameTopLeftFloat[1] + task.yOffset * (frameBottomRightFloat[1] - frameTopLeftFloat[1]) / task.frameHeight
        ]
        const bottomRightFloat = [
            frameTopLeftFloat[0] + (task.xOffset + w) * (frameBottomRightFloat[0] - frameTopLeftFloat[0]) / task.frameWidth,
            frameTopLeftFloat[1] + (task.yOffset + h) * (frameBottomRightFloat[1] - frameTopLeftFloat[1]) / task.frameHeight
        ]

        const values = new Int32Array(w * h)
        const smooth = task.smooth ? new Uint8ClampedArray(w * h) : null
        this.calculate(values, smooth, w, h, topLeftFloat, bottomRightFloat, task.skipTopLeft, task.jobToken)

        return {
            type: 'answer',
            task: task,
            values: values,
            smooth: smooth
        }
    }

    /**
     * @param {Int32Array} values
     * @param {Uint8ClampedArray|null} smooth
     * @param {number} w
     * @param {number} h
     * @param {[number, number]} topleft
     * @param {[number, number]} bottomright
     * @param {boolean} skipTopLeft
     * @param {string} jobToken
     */
    calculate(values, smooth, w, h, topleft, bottomright, skipTopLeft, jobToken) {
        const rmin = topleft[0]
        const rmax = bottomright[0]
        const imin = topleft[1]
        const imax = bottomright[1]
        const dr = (rmax - rmin) / w
        const di = (imax - imin) / h
        for (let y = 0; y < h; y++) {
            if (this.ctx.shouldStop(jobToken)) {
                return
            }
            let im = imin + di * y
            if (skipTopLeft && y % 2 === 0) {
                for (let x = 1; x < w; x += 2) {
                    this.calculatePixel(y, w, x, rmin, dr, im, values, smooth);
                }
            } else {
                for (let x = 0; x < w; x++) {
                    this.calculatePixel(y, w, x, rmin, dr, im, values, smooth);
                }
            }
        }
    }

    /**
     *
     * @param {number} y
     * @param {number} w
     * @param {number} x
     * @param {number} rmin
     * @param {number} dr
     * @param {number} im
     * @param {Int32Array} values
     * @param {Uint8ClampedArray|null} smooth
     */
    calculatePixel(y, w, x, rmin, dr, im, values, smooth) {
        let offset = y * w + x
        let re = rmin + dr * x
        if (smooth) {
            let iter = this.julia
                ? this.mandelbrotJulia(re, im, this.juliaR, this.juliaI, this.max_iter, this.juliaBailout)
                : this.mandelbrot(re, im, this.max_iter, 128)
            let zq = this.lastZq
            let nu = 1
            if (iter > 3) {
                let log_zn = Math.log(zq) / 2
                nu = Math.log(log_zn / Math.log(2)) / Math.log(2)
                iter = Math.floor(iter + 1 - nu)
                nu = nu - Math.floor(nu)
            }
            smooth[offset] = Math.floor(255 - 255 * nu)
            values[offset] = iter
        } else {
            values[offset] = this.julia
                ? this.mandelbrotJulia(re, im, this.juliaR, this.juliaI, this.max_iter, this.juliaBailout)
                : this.mandelbrot(re, im, this.max_iter, 4)
        }
    }

    /**
     * Julia variant: the pixel is the starting point z₀ and (jr, ji) is the fixed seed.
     * Iteration counting matches the perturbation implementation: a pixel already outside
     * the bailout escapes at iteration 0 and yields 4.
     *
     * @returns {number} iter
     */
    mandelbrotJulia(zr, zi, jr, ji, max_iter, bailout) {
        let iter = -1
        let zrq = zr * zr
        let ziq = zi * zi
        let zq = 0.0
        let pr = 0.0
        let pi = 0.0
        let period = 8
        for (;;) {
            if (iter++ === max_iter) {
                this.lastZq = 0
                return 2
            }
            zq = zrq + ziq
            if (zq > bailout) {
                break
            }
            zi = 2 * zr * zi + ji
            zr = zrq - ziq + jr
            if (zr === pr && zi === pi) {
                this.lastZq = 0
                return 2
            }
            if (iter === period) {
                pr = zr
                pi = zi
                period += period
            }
            zrq = zr * zr
            ziq = zi * zi
        }
        this.lastZq = zq
        return iter + 4
    }

    /**
     * Returns the iteration count, with the squared escape radius left in this.lastZq.
     * Interior points (which would reach max_iter) are returned as the marker value 2,
     * exactly like the plain algorithm does.
     *
     * @param {number} re
     * @param {number} im
     * @param {number} max_iter
     * @param {number} bailout
     * @returns {number} iter
     */
    mandelbrot(re, im, max_iter, bailout) {
        // Analytic interior tests: points in the main cardioid or the period-2 bulb never escape,
        // so we can skip iterating them to max_iter.
        const imq = im * im
        const xq = re - 0.25
        const q = xq * xq + imq
        if (q * (q + xq) <= 0.25 * imq) {
            this.lastZq = 0
            return 2
        }
        const xp1 = re + 1
        if (xp1 * xp1 + imq <= 0.0625) {
            this.lastZq = 0
            return 2
        }

        let zr = 0.0
        let zi = 0.0
        let iter = -1
        let zrq = 0.0
        let ziq = 0.0
        let zq = 0.0
        // Brent-style periodicity detection: if the orbit returns exactly to a previously seen
        // point it is caught in a cycle and will never escape (interior point).
        let pr = 0.0
        let pi = 0.0
        let period = 8
        while (zq <= bailout) {
            zi = 2 * zr * zi + im
            zr = zrq - ziq + re
            if (iter++ === max_iter) {
                this.lastZq = 0
                return 2
            }
            if (zr === pr && zi === pi) {
                this.lastZq = 0
                return 2
            }
            if (iter === period) {
                pr = zr
                pi = zi
                period += period
            }
            zrq = zr * zr
            ziq = zi * zi
            zq = zrq + ziq
        }
        this.lastZq = zq
        return iter + 4
    }
}
