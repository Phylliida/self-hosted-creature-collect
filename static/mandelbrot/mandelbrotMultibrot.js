/**
 * The Multibrot set: zₙ₊₁ = zₙ^d + c for an integer degree d (2..8, task.multibrotDegree).
 * The set has d−1 fold rotational symmetry. Implementation of the float64 algorithm,
 * structured like MandelbrotFloat. The smooth coloring uses log d instead of log 2 because
 * the escape growth is |z| → |z|^d.
 */
import {WorkerContext} from "./workerContext.js";

export const DEFAULT_DEGREE = 3

export class MandelbrotMultibrot {
    /**
     * @param {WorkerContext} ctx the context for the worker
     */
    constructor(ctx) {
        this.ctx = ctx
        this.lastZq = 0
    }

    async process(task) {
        this.max_iter = task.maxIter
        this.degree = task.multibrotDegree ?? DEFAULT_DEGREE
        this.logDegree = Math.log(this.degree)
        this.julia = task.julia === true
        if (this.julia) {
            this.juliaR = task.juliaSeed[0].toNumber()
            this.juliaI = task.juliaSeed[1].toNumber()
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

    calculatePixel(y, w, x, rmin, dr, im, values, smooth) {
        let offset = y * w + x
        let re = rmin + dr * x
        if (smooth) {
            let iter = this.julia
                ? this.multibrotJulia(re, im, this.juliaR, this.juliaI, this.max_iter, this.juliaBailout)
                : this.multibrot(re, im, this.max_iter, 128)
            let zq = this.lastZq
            let nu = 1
            if (iter > 3) {
                let log_zn = Math.log(zq) / 2
                nu = Math.log(log_zn / Math.log(2)) / this.logDegree
                iter = Math.floor(iter + 1 - nu)
                nu = nu - Math.floor(nu)
            }
            smooth[offset] = Math.floor(255 - 255 * nu)
            values[offset] = iter
        } else {
            values[offset] = this.julia
                ? this.multibrotJulia(re, im, this.juliaR, this.juliaI, this.max_iter, this.juliaBailout)
                : this.multibrot(re, im, this.max_iter, 4)
        }
    }

    /**
     * Returns the iteration count, with the squared escape radius left in this.lastZq.
     * Interior points (which would reach max_iter) are returned as the marker value 2.
     *
     * @returns {number} iter
     */
    multibrot(re, im, max_iter, bailout) {
        const d = this.degree
        let zr = 0.0
        let zi = 0.0
        let iter = -1
        let zq = 0.0
        // Brent-style periodicity detection, the Mandelbrot cardioid/bulb tests do not apply here
        let pr = 0.0
        let pi = 0.0
        let period = 8
        while (zq <= bailout) {
            // z^d by repeated complex multiplication
            let wr = zr
            let wi = zi
            for (let k = 1; k < d; k++) {
                const t = wr * zr - wi * zi
                wi = wr * zi + wi * zr
                wr = t
            }
            zr = wr + re
            zi = wi + im
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
            zq = zr * zr + zi * zi
        }
        this.lastZq = zq
        return iter + 4
    }

    /**
     * Julia variant: the pixel is the starting point z₀ and (jr, ji) is the fixed seed.
     *
     * @returns {number} iter
     */
    multibrotJulia(zr, zi, jr, ji, max_iter, bailout) {
        const d = this.degree
        let iter = -1
        let zq = 0.0
        let pr = 0.0
        let pi = 0.0
        let period = 8
        for (;;) {
            if (iter++ === max_iter) {
                this.lastZq = 0
                return 2
            }
            zq = zr * zr + zi * zi
            if (zq > bailout) {
                break
            }
            let wr = zr
            let wi = zi
            for (let k = 1; k < d; k++) {
                const t = wr * zr - wi * zi
                wi = wr * zi + wi * zr
                wr = t
            }
            zr = wr + jr
            zi = wi + ji
            if (zr === pr && zi === pi) {
                this.lastZq = 0
                return 2
            }
            if (iter === period) {
                pr = zr
                pi = zi
                period += period
            }
        }
        this.lastZq = zq
        return iter + 4
    }
}
