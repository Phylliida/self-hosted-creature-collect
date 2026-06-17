/**
 * Lyra, an original Lyapunov-style fractal: each pixel is a parameter pair (a, b) and a rhythm
 * sequence (task.lyraSequence, e.g. "AB") picks rₙ ∈ {a, b} per step of the real cubic map
 *
 *   xₙ₊₁ = rₙ·xₙ·(1 − xₙ²)        starting at the critical point x₀ = 1/√3
 *
 * The pixel is colored by the Lyapunov exponent λ = (1/N)·Σ log|rₙ·(1 − 3xₙ²)|: rhythms with
 * a stable (λ < 0) orbit are shaded by their stability depth, chaotic ones (λ ≥ 0) use the
 * interior marker. This is a completely different genre from the escape-time fractals: a real
 * one-dimensional orbit, a fixed number of iterations, and stability coloring. The classic
 * Markus-Lyapunov fractals use the logistic map x(1−x); the cubic family here is Lyra's own.
 *
 * The map keeps x in [0, 1] for r up to 3·√3/2 ≈ 2.598, so that is where the interesting
 * parameter plane lives. Orbits that leave the interval (r beyond the limit) diverge and are
 * colored as chaos. Julia mode does not apply to this fractal and is ignored.
 */
import {WorkerContext} from "./workerContext.js";

export const DEFAULT_SEQUENCE = 'AB'
export const LYRA_START = 1 / Math.sqrt(3)
// λ < 0 is mapped to palette indexes with this resolution; clamped at extreme stability
export const LAMBDA_SCALE = 40
export const LAMBDA_CLAMP = 19.9

export function parseSequence(sequence) {
    const cleaned = String(sequence || DEFAULT_SEQUENCE).toUpperCase().replace(/[^AB]/g, '')
    const usable = cleaned.length >= 1 && cleaned.length <= 16 ? cleaned : DEFAULT_SEQUENCE
    // true = use a, false = use b
    return Array.from(usable, ch => ch === 'A')
}

export function warmupFor(maxIter) {
    return Math.min(64, maxIter >> 3)
}

/**
 * Maps the Lyapunov exponent into the (values, smooth) conventions of the renderer.
 * Chaotic / divergent rhythms (λ ≥ 0) use the interior marker value 2 (rendered dark like
 * escape-time interiors). Stable rhythms are shaded by stability depth starting at value 4.
 * The value is clamped below maxValue so it always indexes within the palette, which is sized
 * to the iteration count.
 */
export function lambdaToValue(lambda, offset, values, smoothBuffer, maxValue) {
    if (!Number.isFinite(lambda) || lambda >= 0) {
        values[offset] = 2 // chaos, rendered like escape-time interior
        return
    }
    const depth = Math.min(-lambda, LAMBDA_CLAMP) * LAMBDA_SCALE
    let value = 4 + Math.floor(depth)
    if (value >= maxValue) {
        value = maxValue - 1
    }
    values[offset] = value
    if (smoothBuffer) {
        smoothBuffer[offset] = Math.floor(255 - 255 * (depth - Math.floor(depth)))
    }
}

export class MandelbrotLyra {
    /**
     * @param {WorkerContext} ctx the context for the worker
     */
    constructor(ctx) {
        this.ctx = ctx
    }

    async process(task) {
        this.max_iter = task.maxIter
        this.seq = parseSequence(task.lyraSequence)
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
        const amin = topleft[0]
        const amax = bottomright[0]
        const bmin = topleft[1]
        const bmax = bottomright[1]
        const da = (amax - amin) / w
        const db = (bmax - bmin) / h
        for (let y = 0; y < h; y++) {
            if (this.ctx.shouldStop(jobToken)) {
                return
            }
            let b = bmin + db * y
            if (skipTopLeft && y % 2 === 0) {
                for (let x = 1; x < w; x += 2) {
                    this.calculatePixel(y, w, x, amin, da, b, values, smooth);
                }
            } else {
                for (let x = 0; x < w; x++) {
                    this.calculatePixel(y, w, x, amin, da, b, values, smooth);
                }
            }
        }
    }

    calculatePixel(y, w, x, amin, da, b, values, smooth) {
        const offset = y * w + x
        const a = amin + da * x
        const lambda = this.lyapunov(a, b, this.max_iter)
        lambdaToValue(lambda, offset, values, smooth, this.max_iter)
    }

    /**
     * Returns the Lyapunov exponent of the (a, b) rhythm, or Infinity when the orbit diverges.
     */
    lyapunov(a, b, maxIter) {
        const seq = this.seq
        const seqLen = seq.length
        const warmup = warmupFor(maxIter)
        let x = LYRA_START
        let si = 0
        for (let i = 0; i < warmup; i++) {
            const r = seq[si] ? a : b
            si = si + 1 === seqLen ? 0 : si + 1
            x = r * x * (1 - x * x)
            if (!(x > -4 && x < 4)) {
                return Infinity
            }
        }
        let lambda = 0
        let n = 0
        for (let i = warmup; i < maxIter; i++) {
            const r = seq[si] ? a : b
            si = si + 1 === seqLen ? 0 : si + 1
            const d = r * (1 - 3 * x * x)
            const ad = d < 0 ? -d : d
            lambda += Math.log(ad > 1e-300 ? ad : 1e-300)
            n++
            x = r * x * (1 - x * x)
            if (!(x > -4 && x < 4)) {
                return Infinity
            }
        }
        return n > 0 ? lambda / n : Infinity
    }
}
