/**
 * The "Mirage" set, a Mandelbrot variant where z is partially blended with its own complex
 * conjugate (its mirror image) before squaring, by an amount that depends on how far the orbit
 * is from the origin:
 *
 *   sₙ   = β / (1 + |zₙ|²)
 *   wₙ   = (1 − sₙ)·zₙ + sₙ·conj(zₙ)        (note: Re(wₙ) = Re(zₙ), Im(wₙ) = (1 − 2sₙ)·Im(zₙ))
 *   zₙ₊₁ = (1 − α)·zₙ + α·(wₙ² + c)
 *
 * with α = 0.55 and β = 1.9 by default (adjustable via task.mirageAlpha/task.mirageBeta).
 * The zₙ₊₁ rule is a guess: the original formula only specified the sₙ and wₙ steps, so the
 * update was completed as an α-relaxed escape-time step, which uses α meaningfully and
 * degenerates to the classic Mandelbrot iteration for s → 0, α → 1.
 *
 * Only implemented with floating point numbers, so the image degrades beyond zoom levels of
 * about 1e13 (no perturbation theory for this iteration).
 */
import {WorkerContext} from "./workerContext.js";

export const DEFAULT_ALPHA = 0.55
export const DEFAULT_BETA = 1.9

/**
 * The relaxation term (1−α)·zₙ can pull a point well outside |z| = 2 back towards the origin,
 * so unlike the plain Mandelbrot iteration a small bailout would misclassify points. The orbit
 * grows monotonically once α·0.85·|z|² outweighs the (2−α)·|z| drift plus the α·|c| offset.
 * The three terms guarantee that for, respectively, strong damping (small α, the extra margin
 * beyond t = 19 covers manually entered α below the slider range), a strong or negative mirror
 * blend (the (1−2s)² factor must stay close to 1 at the escape radius), and views panned far
 * outside the set (cMax bounds |c| over the rendered frame; pass the same frame-wide value to
 * every task so all tiles use the same bailout). For the default α = 0.55, β = 1.9 and any
 * view near the set this keeps the historical bailout of 128.
 */
export function bailoutFor(alpha, beta = 0, cMax = 0) {
    const t = (1 - alpha) / alpha
    const r = 9 + 2.2 * t + 0.45 * Math.max(0, t - 19)
    return Math.max(128, r * r, 25.8 * Math.abs(beta) - 1, 12 * cMax)
}

export class MandelbrotMirage {
    /**
     * @param {WorkerContext} ctx the context for the worker
     */
    constructor(ctx) {
        this.ctx = ctx
        this.lastZq = 0
    }

    async process(task) {
        this.max_iter = task.maxIter
        this.alpha = task.mirageAlpha ?? DEFAULT_ALPHA
        this.beta = task.mirageBeta ?? DEFAULT_BETA
        this.julia = task.julia === true
        const w = task.w
        const h = task.h

        const frameTopLeftFloat = task.frameTopLeft.map(fixed => fixed.toNumber())
        const frameBottomRightFloat = task.frameBottomRight.map(fixed => fixed.toNumber())
        if (this.julia) {
            this.juliaR = task.juliaSeed[0].toNumber()
            this.juliaI = task.juliaSeed[1].toNumber()
            // in julia mode the fixed seed is the only c that occurs
            this.bailout = bailoutFor(this.alpha, this.beta, Math.hypot(this.juliaR, this.juliaI))
        } else {
            const cMax = Math.hypot(
                Math.max(Math.abs(frameTopLeftFloat[0]), Math.abs(frameBottomRightFloat[0])),
                Math.max(Math.abs(frameTopLeftFloat[1]), Math.abs(frameBottomRightFloat[1])))
            this.bailout = bailoutFor(this.alpha, this.beta, cMax)
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
                ? this.mirageJulia(re, im, this.juliaR, this.juliaI, this.max_iter)
                : this.mirage(re, im, this.max_iter)
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
                ? this.mirageJulia(re, im, this.juliaR, this.juliaI, this.max_iter)
                : this.mirage(re, im, this.max_iter)
        }
    }

    /**
     * Julia variant: the pixel is the starting point z₀ and (jr, ji) is the fixed seed.
     *
     * @returns {number} iter
     */
    mirageJulia(zr, zi, jr, ji, max_iter) {
        const alpha = this.alpha
        const beta = this.beta
        const bailout = this.bailout
        const a1 = 1 - alpha
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
            const s = beta / (1 + zq)
            const wi = (1 - 2 * s) * zi
            const tr = zrq - wi * wi + jr
            const ti = 2 * zr * wi + ji
            zr = a1 * zr + alpha * tr
            zi = a1 * zi + alpha * ti
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
     * Points that never escape are returned as the marker value 2, like the other algorithms.
     *
     * @param {number} re
     * @param {number} im
     * @param {number} max_iter
     * @returns {number} iter
     */
    mirage(re, im, max_iter) {
        const alpha = this.alpha
        const beta = this.beta
        const bailout = this.bailout
        const a1 = 1 - alpha
        let zr = 0.0
        let zi = 0.0
        let iter = -1
        let zq = 0.0
        // Brent-style periodicity detection: if the orbit returns exactly to a previously seen
        // point it is caught in a cycle and will never escape (interior point). The relaxation
        // term makes the orbit settle on attracting fixed points/cycles a lot, so this triggers
        // often. The Mandelbrot cardioid/bulb tests do not apply to this iteration.
        let pr = 0.0
        let pi = 0.0
        let period = 8
        while (zq <= bailout) {
            // s = β / (1 + |z|²),  w = z + s·(conj(z) − z): only the imaginary part changes
            const s = beta / (1 + zq)
            const wi = (1 - 2 * s) * zi
            // z' = (1−α)·z + α·(w² + c)
            const tr = zr * zr - wi * wi + re
            const ti = 2 * zr * wi + im
            zr = a1 * zr + alpha * tr
            zi = a1 * zi + alpha * ti
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
}
