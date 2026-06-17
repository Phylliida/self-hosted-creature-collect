/**
 * The Gyre set, an original fractal invented for this explorer (a sibling of the Mirage):
 * before squaring, z is blended with a rotated copy of itself by an amount that depends on
 * how close the orbit is to the origin:
 *
 *   sₙ   = β / (1 + |zₙ|²)
 *   mₙ   = (1 − sₙ) + sₙ·e^{iθ}     (the blend multiplier, a complex number)
 *   zₙ₊₁ = (mₙ·zₙ)² + c
 *
 * Far from the origin m → 1 and the iteration is the plain Mandelbrot one; near the origin
 * orbits are twisted by the angle θ with strength β, which spirals the bulbs and filaments.
 * For θ = 0 the set IS the Mandelbrot set (used as a test oracle). Because conjugation maps
 * θ to −θ, the set has no mirror symmetry — unique among the fractals in this app.
 *
 * Only implemented with floating point numbers up to about 1e13; the perturbation
 * implementation continues to about 1e300.
 */
import {WorkerContext} from "./workerContext.js";

export const DEFAULT_THETA = 90
export const DEFAULT_BETA = 1.5

/**
 * Escape soundness: at |z|² = B the blend strength is s = β/(1+B) and |m| ≥ 1 − 2s, so the
 * squared step still dominates once (1−2s)²·B outweighs |c|. The β term keeps s small enough
 * at the escape radius, the cMax term covers views panned far outside the set.
 */
export function gyreBailout(beta, cMax) {
    return Math.max(128, 25.8 * Math.abs(beta) - 1, 12 * cMax)
}

export class MandelbrotGyre {
    /**
     * @param {WorkerContext} ctx the context for the worker
     */
    constructor(ctx) {
        this.ctx = ctx
        this.lastZq = 0
    }

    async process(task) {
        this.max_iter = task.maxIter
        const theta = (task.gyreTheta ?? DEFAULT_THETA) * Math.PI / 180
        this.beta = task.gyreBeta ?? DEFAULT_BETA
        this.kr = Math.cos(theta) - 1  // k = e^{iθ} − 1, so m = 1 + s·k
        this.ki = Math.sin(theta)
        this.julia = task.julia === true
        const w = task.w
        const h = task.h

        const frameTopLeftFloat = task.frameTopLeft.map(fixed => fixed.toNumber())
        const frameBottomRightFloat = task.frameBottomRight.map(fixed => fixed.toNumber())
        if (this.julia) {
            this.juliaR = task.juliaSeed[0].toNumber()
            this.juliaI = task.juliaSeed[1].toNumber()
            this.bailout = gyreBailout(this.beta, Math.hypot(this.juliaR, this.juliaI))
        } else {
            const cMax = Math.hypot(
                Math.max(Math.abs(frameTopLeftFloat[0]), Math.abs(frameBottomRightFloat[0])),
                Math.max(Math.abs(frameTopLeftFloat[1]), Math.abs(frameBottomRightFloat[1])))
            this.bailout = gyreBailout(this.beta, cMax)
        }
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
                ? this.gyreJulia(re, im, this.juliaR, this.juliaI, this.max_iter)
                : this.gyre(re, im, this.max_iter)
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
                ? this.gyreJulia(re, im, this.juliaR, this.juliaI, this.max_iter)
                : this.gyre(re, im, this.max_iter)
        }
    }

    /**
     * Returns the iteration count, with the squared escape radius left in this.lastZq.
     * Interior points (which would reach max_iter) are returned as the marker value 2.
     *
     * @returns {number} iter
     */
    gyre(re, im, max_iter) {
        const beta = this.beta
        const kr = this.kr
        const ki = this.ki
        const bailout = this.bailout
        let zr = 0.0
        let zi = 0.0
        let iter = -1
        let zq = 0.0
        // Brent-style periodicity detection, the Mandelbrot cardioid/bulb tests do not apply here
        let pr = 0.0
        let pi = 0.0
        let period = 8
        while (zq <= bailout) {
            // m = 1 + s·k,  w = m·z,  z' = w² + c
            const s = beta / (1 + zq)
            const mr = 1 + s * kr
            const mi = s * ki
            const wr = zr * mr - zi * mi
            const wi = zr * mi + zi * mr
            zi = 2 * wr * wi + im
            zr = wr * wr - wi * wi + re
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
    gyreJulia(zr, zi, jr, ji, max_iter) {
        const beta = this.beta
        const kr = this.kr
        const ki = this.ki
        const bailout = this.bailout
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
            const s = beta / (1 + zq)
            const mr = 1 + s * kr
            const mi = s * ki
            const wr = zr * mr - zi * mi
            const wi = zr * mi + zi * mr
            zi = 2 * wr * wi + ji
            zr = wr * wr - wi * wi + jr
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
