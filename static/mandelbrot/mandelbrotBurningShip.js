/**
 * The Burning Ship fractal: zₙ₊₁ = (|Re zₙ| + i·|Im zₙ|)² + c.
 * Since |x|² = x² the real part needs no abs at all:
 *   Re zₙ₊₁ = x² − y² + cr,  Im zₙ₊₁ = 2·|x·y| + ci
 * Implementation of the float64 algorithm, structured like MandelbrotFloat.
 */
import {WorkerContext} from "./workerContext.js";

export class MandelbrotBurningShip {
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
                ? this.burningShipJulia(re, im, this.juliaR, this.juliaI, this.max_iter, this.juliaBailout)
                : this.burningShip(re, im, this.max_iter, 128)
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
                ? this.burningShipJulia(re, im, this.juliaR, this.juliaI, this.max_iter, this.juliaBailout)
                : this.burningShip(re, im, this.max_iter, 4)
        }
    }

    /**
     * Julia variant: the pixel is the starting point z₀ and (jr, ji) is the fixed seed.
     *
     * @returns {number} iter
     */
    burningShipJulia(zr, zi, jr, ji, max_iter, bailout) {
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
            zi = 2 * Math.abs(zr * zi) + ji
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
     * Interior points (which would reach max_iter) are returned as the marker value 2.
     *
     * @param {number} re
     * @param {number} im
     * @param {number} max_iter
     * @param {number} bailout
     * @returns {number} iter
     */
    burningShip(re, im, max_iter, bailout) {
        let zr = 0.0
        let zi = 0.0
        let iter = -1
        let zrq = 0.0
        let ziq = 0.0
        let zq = 0.0
        // Brent-style periodicity detection, the Mandelbrot cardioid/bulb tests do not apply here
        let pr = 0.0
        let pi = 0.0
        let period = 8
        while (zq <= bailout) {
            zi = 2 * Math.abs(zr * zi) + im
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
