/**
 * Kali, the Kaliset (Kali, Fractal Forums ~2011): the inversion map
 *
 *   zₙ₊₁ = abs(zₙ) / dot(zₙ, zₙ) − c        (abs component-wise, dot = x² + y²)
 *
 * coloured by an orbit trap — the orbit's mean closeness to the origin — rather than escape time.
 * Two views, selected by the shared Julia toggle (mirrors Mandelbrot↔Julia):
 *   - main (Julia off): each pixel is the parameter c, started at z₀ = c (z₀ = 0 is invalid — the
 *     map divides by dot(z,z)); this is the parameter plane.
 *   - z-plane (Julia on): each pixel is the starting z₀, with c = the captured Julia seed.
 *
 * Like Lyra this is a non-escape-time genre: a fixed iteration count and stability/trap colouring,
 * so it is float-only-ish (a perturbation engine handles deep zoom) and has its own value mapping.
 */
import {WorkerContext} from "./workerContext.js";

// Orbit-trap colouring. A single closest approach (min |z|) is pathologically noisy for this
// chaotic map, so instead accumulate the orbit's MEAN closeness to the origin,
// Σ exp(−|z|²·KALI_GLOW) / N ∈ (0,1] — a smooth average that yields the iconic Kaliset. KALI_GLOW
// sets the trap radius (larger = tighter); KALI_SCALE maps the mean closeness across the palette.
export const KALI_GLOW = 6
export const KALI_SCALE = 2
// The Kaliset's structure lives in the orbit's transient. Beyond ~this many iterations the chaotic
// orbit has settled onto its attractor (ergodic) and the z-plane flattens, so cap the trap length
// regardless of the global max_iter (Kali doesn't benefit from more, unlike the escape-time genres).
export const KALI_MAX_TRAP = 128

/**
 * Map the orbit's mean closeness (0..1, higher ⇒ more time spent near the origin) into the
 * (values, smooth) convention: values 4..maxValue-1 = palette gradient (closer ⇒ brighter), with
 * `smooth` the fractional byte for sub-index interpolation. Mirrors Lyra's lambdaToValue.
 */
export function closenessToValue(closeness, offset, values, smooth, maxValue) {
    const t = Math.min(1, closeness * KALI_SCALE)
    const fvalue = 4 + t * (maxValue - 5)
    let value = Math.floor(fvalue)
    if (value >= maxValue) value = maxValue - 1
    values[offset] = value
    if (smooth) {
        smooth[offset] = Math.floor(255 - 255 * (fvalue - value))
    }
}

export class MandelbrotKali {
    /**
     * @param {WorkerContext} ctx
     */
    constructor(ctx) {
        this.ctx = ctx
    }

    async process(task) {
        this.max_iter = task.maxIter
        this.trapIters = Math.min(task.maxIter, KALI_MAX_TRAP)
        this.julia = task.julia === true
        if (this.julia) {
            this.cx = task.juliaSeed[0].toNumber()
            this.cy = task.juliaSeed[1].toNumber()
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
        const xmin = topleft[0]
        const xmax = bottomright[0]
        const ymin = topleft[1]
        const ymax = bottomright[1]
        const dx = (xmax - xmin) / w
        const dy = (ymax - ymin) / h
        for (let y = 0; y < h; y++) {
            if (this.ctx.shouldStop(jobToken)) {
                return
            }
            const py = ymin + dy * y
            if (skipTopLeft && y % 2 === 0) {
                for (let x = 1; x < w; x += 2) {
                    this.calculatePixel(y, w, x, xmin, dx, py, values, smooth)
                }
            } else {
                for (let x = 0; x < w; x++) {
                    this.calculatePixel(y, w, x, xmin, dx, py, values, smooth)
                }
            }
        }
    }

    calculatePixel(y, w, x, xmin, dx, py, values, smooth) {
        const offset = y * w + x
        const px = xmin + dx * x
        // z₀ is always the pixel; c is the captured seed in Julia mode, else the pixel itself.
        const cx = this.julia ? this.cx : px
        const cy = this.julia ? this.cy : py
        closenessToValue(this.kaliCloseness(px, py, cx, cy), offset, values, smooth, this.max_iter)
    }

    /**
     * Iterate zₙ₊₁ = abs(zₙ)/dot(zₙ,zₙ) − c from z₀ = (zx, zy), returning the mean closeness to the
     * origin, Σ exp(−|z|²·KALI_GLOW) / N ∈ (0,1]. The start point is not counted (no orbit info);
     * orbits that hit the origin / blow up simply stop contributing.
     */
    kaliCloseness(zx, zy, cx, cy) {
        let sum = 0
        let n = 0
        for (let i = 0; i < this.trapIters; i++) {
            const distSq = zx * zx + zy * zy
            if (i > 0) {
                sum += Math.exp(-distSq * KALI_GLOW)
                n++
            }
            if (distSq === 0) {
                break // exactly at the origin — division undefined
            }
            const inv = 1 / distSq
            zx = Math.abs(zx) * inv - cx
            zy = Math.abs(zy) * inv - cy
            if (!Number.isFinite(zx) || !Number.isFinite(zy)) {
                break
            }
        }
        return n > 0 ? sum / n : 0
    }
}
