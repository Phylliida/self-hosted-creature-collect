/**
 * @author Bert Baron
 */
import * as fxp from './fxp.js'
import * as palette from './palette.js'
import * as favorites from './favorites.js'
import * as mgpu from './mandelbrotWebGPU.js'
import * as pngMeta from './pngMetadata.js'
import {ABS_VARIANTS} from './mandelbrotAbsFamily.js'
import {recordFlight} from './flightRecorder.js'
import {WorkerContext} from "./workerContext.js";

const SQUARE_SIZE = 32 // must be even or -1 for full-frame tasks
const DEFAULT_ITERATIONS = 1000
const DEFAULT_WORKER_COUNT   = navigator.hardwareConcurrency || 4
// const DEFAULT_WORKER_COUNT = 1

const MIN_PIXEL_SIZE = 1
const MAX_PIXEL_SIZE = 16


// Zoom 1 frames the Mandelbrot set, but other fractals (Lyra's off-origin box, the wide Mirage
// set) are larger than the frame at zoom 1, so we allow zooming out well below it. The float
// engines floor precision at 58, which handles these wide low-zoom views fine.
const MIN_ZOOM = fxp.fromNumber(1 / 1024)

// The engines convert fixed-point to float with Math.pow(2, scale), which overflows to Infinity at
// scale >= 1024. Keep any working precision safely below that (~1e300 of zoom is the practical floor).
const MAX_SAFE_PRECISION = 1000

// Each fractal lives in its own part of the complex plane
const FRACTAL_HOME_VIEWS = {
    mandelbrot: [-0.5, 0],
    multibrot: [0, 0],
    burningship: [-0.45, -0.4],
    tricorn: [-0.25, 0],
    phoenix: [-0.3, 0],
    absfamily: [-0.5, 0],
    gyre: [-0.5, 0],
    lyra: [1.8, 1.8, 2.5], // optional 3rd element = home zoom (Lyra's structure lives in a ~1.6-wide box)
    kali: [0.65, 0.65, 2.5], // parameter plane; the structured region sits around (0.65, 0.65)
    mirage: [-5.9, 0],
}
const LYRA_DEFAULT_SEQUENCE = 'AB'

// Cleans a Lyra rhythm string to 1..16 chars of A/B, falling back to the default.
function cleanLyraSequence(s) {
    const c = String(s || '').toUpperCase().replace(/[^AB]/g, '')
    return (c.length >= 1 && c.length <= 16) ? c : LYRA_DEFAULT_SEQUENCE
}
const GYRE_DEFAULT_THETA = 90
const GYRE_DEFAULT_BETA = 1.5
const ABS_DEFAULT_VARIANT = 'celtic'
const MULTIBROT_DEFAULT_DEGREE = 3
const PHOENIX_DEFAULT_Q = -0.5
const PHOENIX_Q_MIN = -2
const PHOENIX_Q_MAX = 2
const MIRAGE_DEFAULT_ALPHA = 0.55
const MIRAGE_DEFAULT_BETA = 1.9
// The sliders cover the comfortable range, values can be entered manually within these bounds.
// Beyond them the iteration explodes so quickly that float64 and the smooth coloring break down.
const MIRAGE_ALPHA_MIN = 0.001
const MIRAGE_ALPHA_MAX = 4
const MIRAGE_BETA_MIN = -20
const MIRAGE_BETA_MAX = 20

class MyWorker {
    constructor(taskqueue, resulthandler) {
        this.taskqueue = taskqueue
        this.resulthandler = resulthandler
        this.worker = new Worker('worker.js', {type: 'module'})
        this.worker.onmessage = (msg) => {
            this.onAnswer(msg.data)
        }
        this.busy = false
    }

    pickTask() {
        if (!this.busy && this.taskqueue.length > 0) {
            this.busy = true
            this.worker.postMessage(this.taskqueue.pop())
        }
    }

    onAnswer(answer) {
        this.busy = false
        this.resulthandler(answer)
        this.pickTask()
    }
}

class Mandelbrot {
    constructor(canvas, progress, paletteSelector) {
        this.canvas = canvas
        this.progress = progress
        this.taskqueue = []
        this.workers = []
        const workerCount = DEFAULT_WORKER_COUNT
        for (let i = 0; i < workerCount; i++) {
            let worker = new MyWorker(this.taskqueue, (result) => {
                this.onResult(result)
            })
            this.workers.push(worker)
        }

        this.mandelbrotGpu = new mgpu.MandelbrotWebGPU(this, new WorkerContext(), error => this.gpuErrorCallback(error))

        this.zoom = fxp.fromNumber(1)
        this.center = [fxp.fromNumber(-0.5), fxp.fromNumber(0)]
        this.max_iter = DEFAULT_ITERATIONS
        this.smooth = false
        this.useGpu = false
        this.supersample = true
        this.recordingFlight = false
        this.fractalType = 'mandelbrot'
        this.mirageAlpha = MIRAGE_DEFAULT_ALPHA
        this.mirageBeta = MIRAGE_DEFAULT_BETA
        this.multibrotDegree = MULTIBROT_DEFAULT_DEGREE
        this.phoenixQ = PHOENIX_DEFAULT_Q
        this.absVariant = ABS_DEFAULT_VARIANT
        this.gyreTheta = GYRE_DEFAULT_THETA
        this.gyreBeta = GYRE_DEFAULT_BETA
        this.lyraSequence = LYRA_DEFAULT_SEQUENCE
        this.juliaMode = false
        this.juliaSeed = null
        this.preJuliaView = null

        this.palette = []
        this.paletteSelector = paletteSelector
        this.initPallete(false)
        this.paletteSelector.addListener(() => {
            this.initPallete(true)
        })

        // current rendering tasks
        this.jobToken = null // hmm, should be something like jobLevelToken
        this.tasksLeft = 0
        this.jobId = 0
        this.jobLevel = 0

        this.resized()
        this.resetStats()
    }

    gpuErrorCallback(message) {
        console.log(`GPU error: ${message}`)
        this.useGpu = false
        gpuToggle.checked = false
        gpuToggle.disabled = true
        gpuToggle.parentElement.setAttribute('title', 'WebGPU not supported');
        new bootstrap.Tooltip(gpuToggle.parentElement);
        redraw()
    }

    resetStats() {
        this.stats = {
            time: 0,
            timeHighPrecision: 0,
            highPrecisionCalculations: 0,
            lowPrecisionMisses: 0,
        }
    }

    setCenter(center) {
        this.center = center
        this._updatePrecision()
    }

    setZoom(zoom) {
        this.zoom = zoom
        this._updatePrecision()
    }

    // The WebGPU implementation only renders the classic Mandelbrot set
    gpuActive() {
        return this.useGpu && this.fractalType === 'mandelbrot' && !this.juliaMode && !this.recordingFlight
    }

    _updatePrecision() {
        this.requiredPrecision = this.zoom.multiply(fxp.fromNumber(this.width).withScale(this.zoom.scale)).bits() + 5
        if (this.gpuActive()) {
            this.precision = Math.max(64, Math.ceil(this.requiredPrecision / 8) * 8)
        } else {
            this.precision = Math.max(58, this.requiredPrecision)
        }
        // High-degree multibrot orbits are far more sensitive (the local multiplier is ~d·|z|^(d−1)),
        // so the precision implied by the zoom alone is not enough to compute the reference orbit
        // accurately at deep iteration counts — the result is blocky glitches. For degree >= 5 add
        // precision scaled by degree and iteration count (~0.02·(d−2) bits/iteration, measured
        // empirically); lower degrees render correctly without it. Only affects the deep/perturbation
        // path (the routing requiredPrecision is unchanged). Keep the >=5 threshold in sync with
        // HIGH_DEGREE in mandelbrotMultibrotPerturbation.js. The boost is capped below 1024 because
        // the engines use Math.pow(2, scale) as a float scaleFactor, which overflows to Infinity at
        // scale >= 1024 (NaN -> BigInt crash); views needing more (very high max_iter) can't be fully
        // resolved by the float perturbation and should use a lower max_iter.
        if (this.fractalType === 'multibrot' && this.multibrotDegree >= 5 && this.requiredPrecision > 58) {
            const boosted = this.precision + Math.ceil(0.02 * (this.multibrotDegree - 2) * this.max_iter)
            this.precision = Math.max(this.precision, Math.min(boosted, MAX_SAFE_PRECISION))
        }
        this.zoom = this.zoom.withScale(this.precision)
        this.center[0] = this.center[0].withScale(this.precision)
        this.center[1] = this.center[1].withScale(this.precision)
    }

    resized() {
        this.initOffscreens();
        this._updatePrecision()
    }

    initOffscreens() {
        this.width = this.canvas.width
        this.height = this.canvas.height
        this.offscreens = []
        // with supersampling a final pass at half pixel size (double resolution) is added,
        // which is drawn back to the canvas with smoothing for anti-aliasing
        const minPixelSize = this.supersample ? MIN_PIXEL_SIZE / 2 : MIN_PIXEL_SIZE
        for (let scale = MAX_PIXEL_SIZE; scale >= minPixelSize; scale /= 2) {
            let offscreen = new Offscreen(this.canvas, scale, scale === MAX_PIXEL_SIZE, scale === minPixelSize)
            this.offscreens.push(offscreen)
        }
    }

    initPallete(redraw) {
        this.palette = palette.initPallet(this.paletteSelector.palette, this.paletteSelector.density, this.paletteSelector.rotate, this.paletteSelector.exp, this.max_iter)
        renderPalette(this.palette)
        if (redraw) {
            const lastScreenNr = this.jobLevel < 1 ? this.offscreens.length : this.jobLevel - 1
            for (let screenNr = 0; screenNr <= lastScreenNr; screenNr++) {
                this.offscreens[screenNr] && this.offscreens[screenNr].render(this.palette, this.max_iter, this.smooth)
            }
            updatePermalink()
        }
    }

    _revokeJobToken() {
        if (this.jobToken) {
            URL.revokeObjectURL(this.jobToken)
            this.jobToken = null
        }
    }

    _createJobToken() {
        this.jobToken = URL.createObjectURL(new Blob())
    }

    startNextJob(resetCaches) {
        if (this.gpuActive()) {
            this.startNextGpuJob(resetCaches)
            return
        }
        this.jobLevel++
        if (!this.permalinkUpdated && (this.jobLevel === this.offscreens.length || performance.now() > this.jobStartTime + 500)) {
            this.permalinkUpdated = true
            updatePermalink()
        }
        if (this.jobLevel === 0) {
            let totalTasks = 0
            for (let screen of this.offscreens) {
                const w = screen.buffer.width
                const h = screen.buffer.height
                const rowsPerTask = SQUARE_SIZE === -1 ? h : SQUARE_SIZE
                const colsPerTask = SQUARE_SIZE === -1 ? w : SQUARE_SIZE
                totalTasks += Math.ceil(h / rowsPerTask) * Math.ceil(w / colsPerTask)
            }
            this.progress.start(totalTasks)
        }

        this._revokeJobToken()
        let taskNumber = 0
        if (this.jobLevel < this.offscreens.length) {
            this._createJobToken();
            const screen = this.offscreens[this.jobLevel];
            const buffer = screen.buffer
            const w = buffer.width
            const h = buffer.height
            const juliaHash = this.juliaMode ? `J${this.juliaSeed[0].bigInt}:${this.juliaSeed[1].bigInt}` : 'M'
            const paramHash = `${this.max_iter}-${this.smooth}-${this.fractalType}-${this.mirageAlpha}-${this.mirageBeta}-${this.multibrotDegree}-${this.phoenixQ}-${this.absVariant}-${this.gyreTheta}-${this.gyreBeta}-${this.lyraSequence}-${juliaHash}`

            const frameTopLeft = this.canvas2complex(0, 0)
            // We need to adjust for the case that the width or height is not dividable by the pixel size
            const roundup = (value) => Math.ceil(value / screen.scale) * screen.scale
            const frameBottomRight = this.canvas2complex(roundup(this.width), roundup(this.height))

            // For the fast low-precision calculations we could render rows to make calculating and rendering even faster
            // for now we focus on optimizing the heavy calculations where squares may provide a benefit
            const rowsPerTask = SQUARE_SIZE === -1 ? h : SQUARE_SIZE
            const colsPerTask = SQUARE_SIZE === -1 ? w : SQUARE_SIZE
            for (let i = 0; i < Math.ceil(h / rowsPerTask); i++) {
                const firstRow = i * rowsPerTask
                const lastRow = Math.min((i + 1) * rowsPerTask, h)
                for (let j = 0; j < Math.ceil(w / colsPerTask); j++) {
                    const firstCol = j * colsPerTask
                    const lastCol = Math.min((j + 1) * colsPerTask, w)
                    let task = {
                        type: 'task',
                        jobId: this.jobId,
                        jobToken: this.jobToken,
                        pixelSize: screen.scale,
                        taskNumber: taskNumber++,
                        xOffset: firstCol,
                        yOffset: firstRow,
                        w: lastCol - firstCol,
                        h: lastRow - firstRow,
                        frameWidth: w,
                        frameHeight: h,
                        frameTopLeft: frameTopLeft,
                        frameBottomRight: frameBottomRight,
                        paramHash: paramHash,
                        resetCaches: resetCaches,
                        // the supersample pass computes all pixels, the transparent-pixel
                        // compositing trick would pollute the downscale averages. Single-pass
                        // renders (flight recording) also compute all pixels because there are
                        // no earlier passes of the same view to composite over.
                        skipTopLeft: this.jobLevel > 0 && screen.scale >= 1 && !this.frameResolve,
                        smooth: this.smooth,
                        maxIter: this.max_iter,
                        precision: this.precision,
                        requiredPrecision: this.requiredPrecision,
                        fractal: this.fractalType,
                        mirageAlpha: this.mirageAlpha,
                        mirageBeta: this.mirageBeta,
                        multibrotDegree: this.multibrotDegree,
                        phoenixQ: this.phoenixQ,
                        absVariant: this.absVariant,
                        gyreTheta: this.gyreTheta,
                        gyreBeta: this.gyreBeta,
                        lyraSequence: this.lyraSequence,
                        julia: this.juliaMode,
                        juliaSeed: this.juliaSeed
                    }
                    this.taskqueue.push(task)
                }
            }
            this.tasksLeft = this.taskqueue.length
            for (let worker of this.workers) {
                worker.pickTask()
            }
        } else {
            if (this.stats.time !== 0) {
                const time = this.stats.time
                const hpPercent = this.stats.timeHighPrecision / time * 100
                console.log(`Calculation time: ${this.stats.time.toFixed(0)}ms (${hpPercent.toFixed(0)}% in ${this.stats.highPrecisionCalculations} high precision points), ${this.stats.lowPrecisionMisses} low precision misses`)
            }
            if (this.frameResolve) {
                const resolve = this.frameResolve
                this.frameResolve = null
                resolve()
            }
        }
    }

    onResult(answer) {
        if (this.gpuActive()) {
            this.onGpuResult(answer)
            return
        }
        // console.log(`Received answer from worker`)
        const task = answer.task
        if (task.jobToken !== this.jobToken) {
            return // ignore results from old render jobs
        }
        if (!this.recordingFlight) {
            this.progress.update() // the flight recorder has its own progress bar
        }
        if (answer.stats) {
            this.stats.time += answer.stats.time
            this.stats.timeHighPrecision += answer.stats.timeHighPrecision
            this.stats.highPrecisionCalculations += answer.stats.highPrecisionCalculations
            this.stats.lowPrecisionMisses += answer.stats.lowPrecisionMisses
        }

        // copy the result buffer into the screen buffer
        // TODO optimize for full-width tasks (fast floating-point rendered part)
        // let offset = task.offset
        // this.offscreens[this.jobLevel].values.set(answer.values, offset)
        // if (this.smooth) {
        //     this.offscreens[this.jobLevel].smooth.set(answer.smooth, offset)
        // }
        let offscreen = this.offscreens[this.jobLevel];
        for (let row = 0; row < task.h; row++) {
            let offset = (task.yOffset + row) * offscreen.buffer.width + task.xOffset
            offscreen.values.set(answer.values.subarray(row * task.w, (row + 1) * task.w), offset)
            if (this.smooth) {
                offscreen.smooth.set(answer.smooth.subarray(row * task.w, (row + 1) * task.w), offset)
            }
        }

        this.tasksLeft--
        if (this.tasksLeft === 0) {
            // const start = performance.now()
            offscreen.render(this.palette, this.max_iter, this.smooth)
            // const end = performance.now()
            // console.log(`Rendering@1/${this.offscreens[this.jobLevel].scale} total: ${(end-start).toFixed(1)}ms`)
            // if (this.jobLevel === 0) {
            //     console.log('l1')
            // }
            this.startNextJob()
        }
    }

    startNextGpuJob(resetCaches) {
        this._revokeJobToken()
        this._createJobToken();

        const screen = this.offscreens.find(s => s.scale === 1) || this.offscreens[this.offscreens.length - 1]
        const w = screen.buffer.width
        const h = screen.buffer.height

        this.progress.start(w * h)
        const paramHash = `${this.max_iter}-${this.smooth}`
        const frameTopLeft = this.canvas2complex(0, 0)
        // We need to adjust for the case that the width or height is not dividable by the pixel size
        const roundup = (value) => Math.ceil(value / screen.scale) * screen.scale
        const frameBottomRight = this.canvas2complex(roundup(this.width), roundup(this.height))

        const task = {
            type: 'task',
            jobId: this.jobId,
            jobToken: this.jobToken,
            pixelSize: screen.scale,
            taskNumber: 0,
            xOffset: 0,
            yOffset: 0,
            w: w,
            h: h,
            frameWidth: w,
            frameHeight: h,
            frameTopLeft: frameTopLeft,
            frameBottomRight: frameBottomRight,
            paramHash: paramHash,
            resetCaches: resetCaches,
            skipTopLeft: false,
            smooth: this.smooth,
            maxIter: this.max_iter,
            precision: this.precision,
            requiredPrecision: this.requiredPrecision
        }
        this.mandelbrotGpu.process(task)
    }

    onGpuResult(answer) {
        console.log(`Received worker answer`)
    }

    onGpuUpdate(answer) {
        if (answer.jobToken !== this.jobToken) {
            console.log("Outdated job")
            return
        }

        const screen = this.offscreens.find(s => s.scale === 1) || this.offscreens[this.offscreens.length - 1]
        screen.values.set(answer.values)
        if (this.smooth) {
            screen.smooth.set(answer.smooth)
        }
        let progress = answer.isFinished ? this.progress.tasks : Math.round((this.progress.tasks - this.progress.done) / 2)
        this.progress.update(progress)
        screen.render(this.palette, this.max_iter, this.smooth)

        if (!this.permalinkUpdated && (answer.isFinished || performance.now() > this.jobStartTime + 500)) {
            this.permalinkUpdated = true
            updatePermalink()
        }
    }

    async render(resetCaches) {
        this.taskqueue.length = 0
        this.jobId++
        this.jobLevel = -1
        this.jobStartTime = performance.now()
        this.permalinkUpdated = false
        this.resetStats()
        this._resolveOrphanedFrame()
        // console.log('Rendering...')
        this.startNextJob(resetCaches)
    }

    // A render superseding a pending renderOnce() cancels its tasks via the job token, so the
    // frame promise must be resolved here or it would never settle
    _resolveOrphanedFrame() {
        if (this.frameResolve) {
            const resolve = this.frameResolve
            this.frameResolve = null
            resolve()
        }
    }

    /**
     * Renders only the final (full resolution) pass and resolves when it is complete.
     * Used by the flight recorder, which needs one finished frame at a time.
     */
    renderOnce() {
        return new Promise(resolve => {
            this.taskqueue.length = 0
            this.jobId++
            this.jobLevel = this.offscreens.length - 2
            this.jobStartTime = performance.now()
            this.permalinkUpdated = true // suppress permalink updates while recording
            this.resetStats()
            this._resolveOrphanedFrame()
            this.frameResolve = resolve
            this.startNextJob(false)
        })
    }

    // x and y are canvas integer, returns a fixed-point complex number
    canvas2complex(x, y) {
        // Make sure x and y are integers because FxP.fromNumber(value, scale) will fail currently when the scale becomes very large
        x = Math.round(x)
        y = Math.round(y)
        const w = fxp.fromNumber(this.width, this.precision)
        const h = fxp.fromNumber(this.height, this.precision)
        let scale = this.zoom.multiply(w).divide(fxp.fromNumber(4, this.precision))
        let center = this.center
        let r = fxp.fromNumber(x, this.precision).subtract(w.divide(fxp.fromNumber(2, this.precision))).divide(scale)
        let i = fxp.fromNumber(y, this.precision).subtract(h.divide(fxp.fromNumber(2, this.precision))).divide(scale)
        return [r.add(center[0]), i.add(center[1])]
    }
}

class PaletteConfig {
    constructor(palette, density, rotate, exp) {
        this.palette = palette
        this.density = density
        this.rotate = rotate
        this.exp = exp
    }
}

class Offscreen {
    constructor(canvas, scale, first, last) {
        this.canvas = canvas
        this.scale = scale
        this.first = first
        this.last = last
        this.maincontext = canvas.getContext('2d')

        this.offscreen = document.createElement('canvas')
        this.offscreen.width = Math.ceil(this.canvas.width / scale)
        this.offscreen.height = Math.ceil(this.canvas.height / scale)
        this.offscreencontext = this.offscreen.getContext('2d')
        this.buffer = this.offscreencontext.createImageData(this.offscreen.width, this.offscreen.height)
        this.values = new Int32Array(this.buffer.width * this.buffer.height)
        this.smooth = new Uint8Array(this.buffer.width * this.buffer.height)

        this.smoothscreen = document.createElement('canvas')
        this.smoothscreen.width = this.offscreen.width
        this.smoothscreen.height = this.offscreen.height
        this.smoothscreencontext = this.smoothscreen.getContext('2d')
        this.smoothbuffer = this.smoothscreencontext.createImageData(this.smoothscreen.width, this.smoothscreen.height)
    }

    render(palette, max_iter, withSmooth) {
        const bufferData = this.buffer.data // Uint8ClampedArray
        const smoothData = this.smoothbuffer.data // Uint8ClampedArray
        const values = this.values // Float32Array
        const smooth = this.smooth // Uint8Array

        for (let i = 0; i < values.length; i++) {
            const iter = values[i]
            bufferData[i * 4] = palette[iter * 4]
            bufferData[i * 4 + 1] = palette[iter * 4 + 1]
            bufferData[i * 4 + 2] = palette[iter * 4 + 2]
            bufferData[i * 4 + 3] = palette[iter * 4 + 3]

            if (withSmooth) {
                smoothData[i * 4] = palette[iter * 4 + 4]
                smoothData[i * 4 + 1] = palette[iter * 4 + 5]
                smoothData[i * 4 + 2] = palette[iter * 4 + 6]
                smoothData[i * 4 + 3] = smooth[i]
            }
        }

        this.offscreencontext.putImageData(this.buffer, 0, 0)
        // upscale passes draw blocky pixels, the supersample pass downscales with smoothing
        this.maincontext.imageSmoothingEnabled = this.scale < 1
        if (this.scale < 1) {
            this.maincontext.imageSmoothingQuality = 'high'
        }
        this.maincontext.drawImage(this.offscreen, 0, 0, this.offscreen.width * this.scale, this.offscreen.height * this.scale)
        if (withSmooth) {
            this.smoothscreencontext.putImageData(this.smoothbuffer, 0, 0)
            this.maincontext.drawImage(this.smoothscreen, 0, 0, this.smoothscreen.width * this.scale, this.smoothscreen.height * this.scale)
        }
    }
}

class ProgressMonitor {
    constructor(canvas) {
        this.canvas = canvas
        this.ctx = canvas.getContext('2d')
        this.ctx.fillStyle = 'black'
        this.ctx.fillRect(0, 0, canvas.width, canvas.height)
        this.tasks = 0
        this.done = 0
        this.lastUpdate = 0
        this.startTime = 0
    }

    start(tasks) {
        this.tasks = tasks
        this.done = 0
        this.lastUpdate = performance.now()
        this.startTime = this.lastUpdate
        this._draw(0)
        this.canvas.style.display = 'block'
    }

    update(amount = 1) {
        this.done = Math.min(this.done + amount, this.tasks)
        const now = performance.now()
        if (now - this.lastUpdate > 100) {
            const percent = this.done / this.tasks * 100
            // console.log(`Rendering ${percent.toFixed(0)}%`)
            this.lastUpdate = now
            this._draw(percent)
        }
        if (this.done === this.tasks) {
            this._draw(100)
            const jobTime = now - this.startTime
            // console.log(`Rendering completed in ${jobTime.toFixed(0)}ms`)
            document.getElementById('renderTimeValue').innerText = `${jobTime.toFixed(0)}ms`
            this.canvas.style.display = 'none'
        }
    }

    finish() {
        this.update(this.tasks)
    }

    _draw(percentage) {
        // draw a red arc on a white circle with a transparent background
        const ctx = this.ctx
        const width = this.canvas.width
        const height = this.canvas.height
        const radius = Math.min(width, height) / 2
        const centerX = width / 2
        const centerY = height / 2
        ctx.clearRect(0, 0, width, height)
        ctx.fillStyle = 'white'
        ctx.beginPath()
        ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI)
        ctx.fill()
        ctx.fillStyle = 'red'
        ctx.beginPath()
        ctx.arc(centerX, centerY, radius, 0, (1 - percentage / 100) * 2 * Math.PI)
        ctx.lineTo(centerX, centerY)
        ctx.fill()
    }
}

function renderPalette(palette) {
    const ctx = paletteCanvasElement.getContext('2d')
    const width = paletteCanvasElement.offsetWidth
    const height = paletteCanvasElement.offsetHeight
    paletteCanvasElement.width = width
    paletteCanvasElement.height = height
    const offset = 4
    const paletteSize = palette.length / 4 - offset
    for (let i = 0; i < paletteSize; i++) {
        const colorIndex = i + offset
        const pos = Math.floor(i * width / paletteSize)
        const w = Math.floor((i + 1) * width / paletteSize) - pos
        const r = palette[colorIndex * 4]
        const g = palette[colorIndex * 4 + 1]
        const b = palette[colorIndex * 4 + 2]
        ctx.fillStyle = `rgb(${r},${g},${b})`
        ctx.fillRect(pos, 0, w, height)
    }
}

function initMenu() {
    const menuToggle = document.getElementById("menu-toggle");
    menuToggle.addEventListener("click", function (e) {
        const menu = document.getElementById("settings")
        menu.classList.toggle("hidden")
        menuToggle.classList.toggle("hidden")
    })
}

initMenu()

const canvasElement = document.getElementById("mandelbrot-canvas")
const progressElement = document.getElementById("progress-canvas")
const paletteCanvasElement = document.getElementById("palette-canvas")

const tempCanvas = document.createElement('canvas');

class PaletteSelector {
    constructor() {
        this.listeners = []
        this.palette = palette.getPalette('original')
        this.density = 1
        this.rotate = 0
    }

    init() {
        const paletteMenu = document.getElementById("palette-menu");
        paletteMenu.innerHTML = "";
        // Populate the dropdown dynamically
        palette.palettes().forEach(p => {
            const listItem = document.createElement("li");
            listItem.classList.add('d-flex', 'align-items-center');
            const anchor = document.createElement("a");
            anchor.classList.add("dropdown-item");
            anchor.href = "#";
            anchor.dataset.paletteId = p.id
            anchor.classList.add('flex-grow-1', 'd-flex', 'align-items-center');
            if (p.id === this.palette.id) {
                anchor.classList.add("active")
            }
            anchor.appendChild(createPreviewCanvas(p, 40))

            const nameSpan = document.createElement("span");
            nameSpan.textContent = p.name;
            anchor.appendChild(nameSpan);

            const actionsSpan = document.createElement('span');
            actionsSpan.className = 'palette-actions';
            if (p.isCustom && p.isCustom()) {
                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'palette-action palette-edit';
                editBtn.title = 'Edit palette';
                editBtn.setAttribute('aria-label', 'Edit palette');
                editBtn.textContent = '✎';
                editBtn.dataset.paletteId = p.id;
                editBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    customPaletteComponent.editingId = p.id;
                    this.setPalette(palette.getPalette(p.id));
                    showCustomPaletteContainer();
                });
                actionsSpan.appendChild(editBtn);
            }

            anchor.addEventListener("click", () => {
                this.setPalette(palette.getPalette(p.id))
                this.notifyListeners()
            });
            listItem.appendChild(anchor);
            listItem.appendChild(actionsSpan);
            paletteMenu.appendChild(listItem);
        });
        // Add custom palette option
        const addCustomLi = document.createElement("li");
        const addCustomAnchor = document.createElement("a");
        addCustomAnchor.classList.add("dropdown-item");
        addCustomAnchor.href = "#";
        addCustomAnchor.innerHTML = '<span style="font-weight:bold;">＋</span> Add custom palette';
        addCustomAnchor.addEventListener("click", () => {
            showCustomPaletteContainer();
        });
        addCustomLi.appendChild(addCustomAnchor);
        paletteMenu.appendChild(addCustomLi);

        this.densitySlider = document.getElementById("palette-density");
        this.densitySlider.addEventListener("input", () => {
            this.setDensity(this.densitySlider.value, true)
        });

        this.rotateSlider = document.getElementById("palette-rotate");
        this.rotateSlider.addEventListener("input", () => {
            this.setRotate(this.rotateSlider.value, true)
        });
    }

    setPalette(palette) {
        this.palette = palette
        const paletteMenu = document.getElementById("palette-menu")
        for (let child of paletteMenu.children) {
            const anchor = child.children[0]
            if (anchor.dataset.paletteId === palette.id) {
                anchor.classList.add("active")
            } else {
                anchor.classList.remove("active")
            }
        }

        const paletteDropdown = document.getElementById("palette-dropdown")
        paletteDropdown.innerText = palette.name
    }

    setEmbeddedPalette(colors, mirror) {
        let paletteObject = palette.createPaletteFromColors('embedded', '<embedded>', colors, mirror)
        for (let p of palette.palettes()) {
            if (p.isSamePalette(paletteObject)) {
                paletteObject = p
            }
        }
        this.setPalette(paletteObject)
    }

    setAnonymousPalette(palette) {
        this.palette = palette
    }

    setDensity(density, skipControl) {
        this.density = density
        skipControl || (this.densitySlider.value = this.density)
        this.notifyListeners()
    }

    setRotate(rotate, skipControl) {
        this.rotate = rotate
        // document.getElementById("palette-rotate-label").innerText = "Rotate (" + rotate + ")"
        skipControl || (this.rotateSlider.value = this.rotate)
        this.notifyListeners()
    }

    addListener(listener) {
        this.listeners.push(listener)
    }

    notifyListeners() {
        for (let listener of this.listeners) {
            listener(this.palette)
        }
    }
}

function createPreviewCanvas(palette, size) {
    const preview = document.createElement("canvas");
    preview.width = size;
    preview.height = 12;
    preview.style.verticalAlign = "middle";
    preview.style.marginRight = "8px";
    const ctx = preview.getContext("2d");
    for (let x = 0; x < preview.width; x++) {
        let color = palette.getColor(x / preview.width * 100, 0);
        ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
        ctx.fillRect(x, 0, 1, preview.height);
    }
    return preview;
}


const paletteSelector = new PaletteSelector();

const fractal = new Mandelbrot(canvasElement, new ProgressMonitor(progressElement), paletteSelector)

// Captured synchronously at module load: the first render can finish and update the permalink
// before init() runs (the load event can be delayed by slow stylesheets), which would otherwise
// overwrite the requested location with the default view before it was ever read.
const initialUrlParams = new URL(window.location).searchParams.get('params')

let redrawTimeout = null;

async function redraw(resetCaches, cooldown) {
    if (fractal.recordingFlight) {
        return // the recorder owns the canvas and the render pipeline
    }
    showZoomFactor()
    if (redrawTimeout) {
        clearTimeout(redrawTimeout)
        redrawTimeout = null
    }

    if (cooldown) {
        redrawTimeout = setTimeout(() => {
            fractal.render(resetCaches)
            redrawTimeout = null;
        }, cooldown)
    } else {
        await fractal.render(resetCaches)
    }
}

function showZoomFactor() {
    const intVal = fractal.zoom.bigIntValue()
    let text
    if (intVal > 0n) {
        // zoom >= 1, possibly far beyond float range (deep zoom) — format from the integer digits
        const zoomStr = intVal.toString()
        const zoomExp = zoomStr.length - 1
        const zoomMantissa = zoomStr[0] + '.' + zoomStr.substring(1, 3)
        text = `${zoomMantissa}e${zoomExp}`
    } else {
        // zoom < 1 (zoomed out below the Mandelbrot frame) — always within float range
        const n = fractal.zoom.toNumber()
        text = n > 0 ? n.toExponential(2) : '0'
    }
    document.getElementById('zoomValue').innerText = text
}

let lastX = canvasElement.width / 2
let lastY = canvasElement.height / 2
let dragStart = null
// let dragged = false

// Tap-to-zoom state. dragStart follows the pointer during a drag (it's
// reset every move), so it can't tell a tap from a pan — these track the
// gesture's ORIGINAL down point and whether it moved past the threshold.
let tapDownPos = null
let gestureMoved = false
let multiTouchGesture = false
const TAP_ZOOM_FACTOR = 2  // a single tap zooms in ~2x at the tapped point

const scaleFactor = 1.1;

function zoomWithClicks(clicks, cooldown) {
    zoomWithFactor(Math.pow(scaleFactor, clicks), cooldown)
}

function zoomWithFactor(factor, cooldown) {
    if (fractal.recordingFlight) return
    const lowerBound = MIN_ZOOM.withScale(fractal.precision)
    if (fractal.zoom.leq(lowerBound) && factor < 1) return
    // Only mandelbrot without julia has an extended-float implementation, everything else caps
    // the zoom where the perturbation algorithm runs out of float64 exponent range (about 1e300)
    if ((fractal.fractalType !== 'mandelbrot' || fractal.juliaMode) && factor > 1 && fractal.requiredPrecision > 1000) return
    // Lyra renders only with the float engine (Lyapunov structure has finite zoom depth), so it
    // caps where float can still resolve neighbouring pixels in parameter space (about 1e13)
    if (fractal.fractalType === 'lyra' && factor > 1 && fractal.requiredPrecision > 58) return
    let bigFactor = fxp.fromNumber(factor, fractal.precision);
    const ptr = fractal.canvas2complex(lastX, lastY)
    fractal.setCenter(ptr)
    fractal.setZoom(fractal.zoom.multiply(bigFactor).max(lowerBound))
    const newPtr = fractal.canvas2complex(lastX, lastY)
    fractal.setCenter([fractal.center[0].add(ptr[0].subtract(newPtr[0])), fractal.center[1].add(ptr[1].subtract(newPtr[1]))])
    scaleCanvas(factor, lastX, lastY)
    redraw(false, cooldown);
}

function handleScroll(evt) {
    updateMousePos(evt)
    const delta = evt.wheelDelta ? evt.wheelDelta / 40 : (evt.detail ? -evt.detail : 0)
    if (delta) zoomWithClicks(delta, 0) // TODO only apply a cooldown when rendering takes long
    evt.preventDefault()
}

function updateIterations(delta) {
    setIterations(fractal.max_iter + delta)
}

function setIterations(value) {
    const newIter = Math.min(100000, Math.max(100, value))
    if (newIter !== fractal.max_iter) {
        fractal.max_iter = newIter
        fractal._updatePrecision() // high-degree multibrot precision depends on max_iter
        console.log(`max_iter: ${fractal.max_iter}`)
        fractal.initPallete()
        iterationsElement.value = fractal.max_iter
        redraw()
        return true
    }
    return false
}

function onMouseDown(evt) {
    if (fractal.recordingFlight) return
    updateMousePos(evt)
    dragStart = [lastX, lastY]
    tapDownPos = [lastX, lastY]
    gestureMoved = false
    multiTouchGesture = false
}

function onMouseMove(evt) {
    updateMousePos(evt)
    if (evt.type === "mousemove" && (evt.buttons & 1) === 0) {
        // Avoid dragging whem the mouse is hovered onto the canvas from the outside
        dragStart = null
        return
    }

    if (dragStart) {
        // Mark the gesture as a pan (not a tap) once it moves past a small
        // threshold from where it started — ~2% of canvas width.
        if (tapDownPos) {
            const mdx = lastX - tapDownPos[0], mdy = lastY - tapDownPos[1]
            const tol = canvasElement.width * 0.02
            if (mdx * mdx + mdy * mdy > tol * tol) gestureMoved = true
        }
        const ptr = fractal.canvas2complex(lastX, lastY)
        const startPtr = fractal.canvas2complex(dragStart[0], dragStart[1])
        fractal.center = [fractal.center[0].add(startPtr[0].subtract(ptr[0])), fractal.center[1].add(startPtr[1].subtract(ptr[1]))]
        panCanvas(lastX - dragStart[0], lastY - dragStart[1])
        dragStart = [lastX, lastY]
        redraw()
    }
}

// scales the current canvas image by the given factor around the given point
// This gives immediate feedback to the user, while the fractal is being rendered in the background
function scaleCanvas(factor, x, y) {
    // console.log(`Scaling canvas by ${factor} around (${x}, ${y})`)
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(canvasElement, 0, 0);
    const ctx = canvasElement.getContext('2d');
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(factor, factor);
    ctx.translate(-x, -y);
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(canvasElement, 0, 0) //, -x, -y, canvasElement.width, canvasElement.height);
    ctx.restore();
}

function panCanvas(dx, dy) {
    const ctx = canvasElement.getContext('2d');
    ctx.save();
    ctx.translate(dx, dy);
    ctx.drawImage(canvasElement, 0, 0);
    ctx.restore();
}

function onMouseUp(evt) {
    // A tap/click — no pan, no pinch — zooms in toward the tapped point.
    // Done BEFORE updateMousePos because on touchend updateMousePos can't
    // read coordinates (empty touches) and would clobber lastX/lastY; at
    // this point they still hold the tap location.
    if (tapDownPos && !gestureMoved && !multiTouchGesture && !fractal.recordingFlight) {
        lastX = tapDownPos[0]
        lastY = tapDownPos[1]
        zoomWithFactor(TAP_ZOOM_FACTOR, 0)
    }
    updateMousePos(evt)
    dragStart = null
    tapDownPos = null
    gestureMoved = false
}

function updateMousePos(evt) {
    let x, y
    if (evt.touches && evt.touches.length > 0) {
        x = evt.touches[0].pageX - canvasElement.offsetLeft
        y = evt.touches[0].pageY - canvasElement.offsetTop
    } else {
        x = evt.offsetX || (evt.pageX - canvasElement.offsetLeft)
        y = evt.offsetY || (evt.pageY - canvasElement.offsetTop)
    }
    [lastX, lastY] = toGraphicsCoordinates(x, y)
}

function toGraphicsCoordinates(x, y) {
    return [x / canvasElement.offsetWidth * canvasElement.width, y / canvasElement.offsetHeight * canvasElement.height]
}

let devicePixelBoxSize = null

function onResize(entries) {
    // let debugText = `${canvasElement.offsetWidth}x${canvasElement.offsetHeight}`

    devicePixelBoxSize = null
    if (entries && entries.length > 0) {
        const entry = entries[0]
        if (entry.devicePixelContentBoxSize) {
            const w = entry.devicePixelContentBoxSize[0].inlineSize
            const h = entry.devicePixelContentBoxSize[0].blockSize
            if (w !== canvasElement.offsetWidth || h !== canvasElement.offsetHeight) {
                devicePixelBoxSize = [w, h]
            }
        }
    }
    fullResToggle.disabled = devicePixelBoxSize == null
    resizeToCanvasSize()
}

function resizeToCanvasSize() {
    let width = canvasElement.offsetWidth
    let height = canvasElement.offsetHeight

    if (fullResToggle.checked && devicePixelBoxSize != null) {
        [width, height] = devicePixelBoxSize
    }

    document.getElementById('sizeValue').innerText = `${width}x${height}`


    canvasElement.width = width
    canvasElement.height = height

    resizeTmpCanvas()
    fractal.resized()
    showZoomFactor()
    redraw()
}

function toggleFullScreen() {
    if (document.fullscreenElement) {
        document.exitFullscreen()
    } else {
        document.getElementById('main').requestFullscreen()
    }
}

const ELEMENTS_WITH_FS_CLASS = ['mandelbrot', 'palette-canvas', 'settings', 'footer', 'menu-toggle']

function resizeTmpCanvas() {
    tempCanvas.width = canvasElement.width
    tempCanvas.height = canvasElement.height
}

const debugElement = document.getElementById('debug')

const appElement = document.getElementById('app')
const iterationsElement = document.getElementById('max-iterations')
const fullScreenButton = document.getElementById('fullscreen')
const smoothToggle = document.getElementById('smooth')
const supersampleToggle = document.getElementById('supersample')
const fractalSelect = document.getElementById('fractal-select')
const juliaToggle = document.getElementById('julia')
const juliaParamsRow = document.getElementById('julia-params')
const juliaXSlider = document.getElementById('julia-x')
const juliaXInput = document.getElementById('julia-x-value')
const juliaISlider = document.getElementById('julia-i')
const juliaIInput = document.getElementById('julia-i-value')
// The Julia seed sliders span +/- this around an adaptive base (set to the captured seed), so they
// work wherever a fractal's set lives (Mandelbrot seeds near 0, the Mirage set near -5.9, ...).
const JULIA_SLIDER_SPAN = 2
let juliaSliderBase = [0, 0]
const absParamsRow = document.getElementById('abs-params')
const gyreParamsRow = document.getElementById('gyre-params')
const gyreThetaSlider = document.getElementById('gyre-theta')
const gyreThetaInput = document.getElementById('gyre-theta-value')
const gyreBetaSlider = document.getElementById('gyre-beta')
const gyreBetaInput = document.getElementById('gyre-beta-value')
const absVariantSelect = document.getElementById('abs-variant')
const lyraParamsRow = document.getElementById('lyra-params')
const lyraSequenceInput = document.getElementById('lyra-sequence')
const multibrotParamsRow = document.getElementById('multibrot-params')
const multibrotDegreeSlider = document.getElementById('multibrot-degree')
const multibrotDegreeLabel = document.getElementById('multibrot-degree-label')
const phoenixParamsRow = document.getElementById('phoenix-params')
const phoenixQSlider = document.getElementById('phoenix-q')
const phoenixQInput = document.getElementById('phoenix-q-value')
const mirageParamsRow = document.getElementById('mirage-params')
const mirageAlphaSlider = document.getElementById('mirage-alpha')
const mirageBetaSlider = document.getElementById('mirage-beta')
const mirageAlphaInput = document.getElementById('mirage-alpha-value')
const mirageBetaInput = document.getElementById('mirage-beta-value')
const resetElement = document.getElementById('reset')
const fullResToggle = document.getElementById('fullres')
const gpuToggle = document.getElementById('gpu')
//const gpuLabel = document.querySelector('label[for="gpu"]');
// parent element of the gpuToggle
//const gpuParent = gpuToggle.parentElement


let lastTouchDistance = null
let lastTouchCenter = null

function initListeners() {
    addEventListener("fullscreenchange", (event) => {
        if (document.fullscreenElement) {
            for (let element of ELEMENTS_WITH_FS_CLASS) {
                document.getElementById(element).classList.add('fullscreen')
            }
            document.documentElement.setAttribute('data-bs-theme', 'dark')
            // Don't auto-hide the menu in full-screen mode for now because users may not be aware
            // of the hidden menu toggle button
            // document.getElementById('menu-toggle').classList.add('hidden')
            // document.getElementById('settings').classList.add('hidden')

        } else {
            for (let element of ELEMENTS_WITH_FS_CLASS) {
                document.getElementById(element).classList.remove('fullscreen')
            }
            document.documentElement.setAttribute('data-bs-theme', 'light')
        }
    });

    const tooltipList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]')).map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl);
    });

    new ResizeObserver(onResize).observe(canvasElement)

    canvasElement.addEventListener('mousedown', onMouseDown)
    canvasElement.addEventListener('mousemove', onMouseMove)
    canvasElement.addEventListener('mouseup', onMouseUp)

    canvasElement.addEventListener('DOMMouseScroll', handleScroll, false)
    canvasElement.addEventListener('mousewheel', handleScroll, false)

    canvasElement.addEventListener('touchstart', (evt) => {
        if (evt.touches.length === 1) {
            onMouseDown(evt)
        }
        if (evt.touches.length === 2) {
            // A pinch is not a tap — suppress tap-to-zoom for this gesture.
            multiTouchGesture = true
            lastTouchDistance = Math.hypot(evt.touches[0].pageX - evt.touches[1].pageX, evt.touches[0].pageY - evt.touches[1].pageY)
            lastTouchCenter = [(evt.touches[0].pageX + evt.touches[1].pageX) / 2, (evt.touches[0].pageY + evt.touches[1].pageY) / 2]
        }
        evt.preventDefault()
    })
    canvasElement.addEventListener('touchmove', (evt) => {
        if (evt.touches.length === 1) {
            onMouseMove(evt)
            if (document.fullscreenElement != null) {
                // no preventDefault in full-screen mode because this may be used to exit full-screen
                evt.preventDefault()
            }
        }
        if (evt.touches.length === 2) {
            const newTouchDistance = Math.hypot(evt.touches[0].pageX - evt.touches[1].pageX, evt.touches[0].pageY - evt.touches[1].pageY)
            const newTouchCenter = [(evt.touches[0].pageX + evt.touches[1].pageX) / 2, (evt.touches[0].pageY + evt.touches[1].pageY) / 2]
            const factor = newTouchDistance / lastTouchDistance;

            [lastX, lastY] = toGraphicsCoordinates(newTouchCenter[0] - canvasElement.offsetLeft, newTouchCenter[1] - canvasElement.offsetTop)
            const [newX, newY] = toGraphicsCoordinates(lastTouchCenter[0] - canvasElement.offsetLeft, lastTouchCenter[1] - canvasElement.offsetTop)

            // Pan the canvas based on the movement of the center of the two fingers
            const ptr = fractal.canvas2complex(lastX, lastY)
            const startPtr = fractal.canvas2complex(newX, newY)
            fractal.center = [fractal.center[0].add(startPtr[0].subtract(ptr[0])), fractal.center[1].add(startPtr[1].subtract(ptr[1]))]
            panCanvas(lastX - newX, lastY - newY)

            zoomWithFactor(factor, 0)
            lastTouchDistance = newTouchDistance
            lastTouchCenter = newTouchCenter
            evt.preventDefault()
        }
    })
    canvasElement.addEventListener('touchend', (evt) => {
        onMouseUp(evt)
        lastTouchDistance = null
        lastTouchCenter = null
        // evt.preventDefault()
    })

    iterationsElement.addEventListener('change', (event) => {
        setIterations(parseInt(event.target.value))
    })
    iterationsElement.addEventListener('keydown', (event) => {
        event.stopPropagation()
    })
    smoothToggle.addEventListener('change', (event) => {
        fractal.smooth = event.target.checked
        // Smooth and supersample are mutually exclusive.
        if (fractal.smooth && fractal.supersample) {
            fractal.supersample = false
            supersampleToggle.checked = false
            fractal.resized()
        }
        redraw()
    })
    fractalSelect.addEventListener('change', (event) => {
        fractal.fractalType = event.target.value
        exitJuliaMode()
        // A location in one fractal is meaningless in the other, so start at the fractal's home view
        applyHomeView(fractal.fractalType)
        updateFractalControls()
        redraw()
    })
    juliaToggle.addEventListener('change', () => {
        if (juliaToggle.checked) {
            // the current view center becomes the julia seed, at full precision
            fractal.juliaSeed = [fractal.center[0], fractal.center[1]]
            fractal.preJuliaView = {center: [fractal.center[0], fractal.center[1]], zoom: fractal.zoom}
            fractal.juliaMode = true
            recenterJuliaSliders()
            fractal.setZoom(fxp.fromNumber(1))
            fractal.setCenter([fxp.fromNumber(0), fxp.fromNumber(0)])
        } else {
            const previous = fractal.preJuliaView
            exitJuliaMode()
            if (previous) {
                fractal.setZoom(previous.zoom)
                fractal.setCenter([previous.center[0], previous.center[1]])
            } else {
                applyHomeView(fractal.fractalType)
            }
        }
        updateFractalControls()
        redraw()
    })
    function onJuliaSeedSlider(slider, input, index) {
        if (!fractal.juliaMode || !fractal.juliaSeed) return
        const v = Number(slider.value)
        const seed = [fractal.juliaSeed[0], fractal.juliaSeed[1]]
        seed[index] = fxp.fromNumber(v)
        fractal.juliaSeed = seed
        input.value = v
        redraw(false, 120)
    }
    function onJuliaSeedInput(slider, input, index) {
        if (!fractal.juliaMode || !fractal.juliaSeed) return
        const v = clampMirageValue(Number(input.value), -100, 100, index === 0 ? juliaSeedRe() : juliaSeedIm())
        const seed = [fractal.juliaSeed[0], fractal.juliaSeed[1]]
        seed[index] = fxp.fromNumber(v)
        fractal.juliaSeed = seed
        recenterJuliaSliders() // typed value may be off-slider, recenter the slider around it
        updateFractalControls()
        redraw()
    }
    juliaXSlider.addEventListener('input', () => onJuliaSeedSlider(juliaXSlider, juliaXInput, 0))
    juliaISlider.addEventListener('input', () => onJuliaSeedSlider(juliaISlider, juliaIInput, 1))
    juliaXSlider.addEventListener('change', () => redraw())
    juliaISlider.addEventListener('change', () => redraw())
    juliaXInput.addEventListener('change', () => onJuliaSeedInput(juliaXSlider, juliaXInput, 0))
    juliaIInput.addEventListener('change', () => onJuliaSeedInput(juliaISlider, juliaIInput, 1))
    for (const input of [juliaXInput, juliaIInput]) {
        input.addEventListener('keydown', (event) => event.stopPropagation())
    }
    fractalSelect.addEventListener('keydown', (event) => {
        event.stopPropagation()
    })
    gyreThetaSlider.addEventListener('input', () => {
        fractal.gyreTheta = Number(gyreThetaSlider.value)
        gyreThetaInput.value = fractal.gyreTheta
        redraw(false, 120)
    })
    gyreThetaSlider.addEventListener('change', () => {
        redraw()
    })
    gyreThetaInput.addEventListener('change', () => {
        fractal.gyreTheta = clampMirageValue(Number(gyreThetaInput.value), -180, 180, fractal.gyreTheta)
        updateFractalControls()
        redraw()
    })
    gyreBetaSlider.addEventListener('input', () => {
        fractal.gyreBeta = Number(gyreBetaSlider.value)
        gyreBetaInput.value = fractal.gyreBeta
        redraw(false, 120)
    })
    gyreBetaSlider.addEventListener('change', () => {
        redraw()
    })
    gyreBetaInput.addEventListener('change', () => {
        fractal.gyreBeta = clampMirageValue(Number(gyreBetaInput.value), 0, 20, fractal.gyreBeta)
        updateFractalControls()
        redraw()
    })
    for (const input of [gyreThetaInput, gyreBetaInput]) {
        input.addEventListener('keydown', (event) => {
            event.stopPropagation()
        })
    }
    absVariantSelect.addEventListener('change', (event) => {
        fractal.absVariant = ABS_VARIANTS[event.target.value] ? event.target.value : ABS_DEFAULT_VARIANT
        redraw()
    })
    lyraSequenceInput.addEventListener('change', (event) => {
        fractal.lyraSequence = cleanLyraSequence(event.target.value)
        lyraSequenceInput.value = fractal.lyraSequence
        redraw()
    })
    lyraSequenceInput.addEventListener('keydown', (event) => {
        event.stopPropagation()
    })
    multibrotDegreeSlider.addEventListener('input', () => {
        fractal.multibrotDegree = Math.round(Number(multibrotDegreeSlider.value))
        multibrotDegreeLabel.innerText = `Degree: ${fractal.multibrotDegree}`
        redraw(false, 120)
    })
    multibrotDegreeSlider.addEventListener('change', () => {
        redraw()
    })
    phoenixQSlider.addEventListener('input', () => {
        fractal.phoenixQ = Number(phoenixQSlider.value)
        phoenixQInput.value = fractal.phoenixQ
        redraw(false, 120)
    })
    phoenixQSlider.addEventListener('change', () => {
        redraw()
    })
    phoenixQInput.addEventListener('change', () => {
        fractal.phoenixQ = clampMirageValue(Number(phoenixQInput.value), PHOENIX_Q_MIN, PHOENIX_Q_MAX, fractal.phoenixQ)
        updateFractalControls()
        redraw()
    })
    phoenixQInput.addEventListener('keydown', (event) => {
        event.stopPropagation()
    })
    mirageAlphaSlider.addEventListener('input', () => {
        fractal.mirageAlpha = Number(mirageAlphaSlider.value)
        mirageAlphaInput.value = fractal.mirageAlpha
        redraw(false, 120)
    })
    mirageAlphaSlider.addEventListener('change', () => {
        redraw()
    })
    mirageBetaSlider.addEventListener('input', () => {
        fractal.mirageBeta = Number(mirageBetaSlider.value)
        mirageBetaInput.value = fractal.mirageBeta
        redraw(false, 120)
    })
    mirageBetaSlider.addEventListener('change', () => {
        redraw()
    })
    mirageAlphaInput.addEventListener('change', () => {
        fractal.mirageAlpha = clampMirageValue(Number(mirageAlphaInput.value), MIRAGE_ALPHA_MIN, MIRAGE_ALPHA_MAX, fractal.mirageAlpha)
        syncMirageInputs()
        redraw()
    })
    mirageBetaInput.addEventListener('change', () => {
        fractal.mirageBeta = clampMirageValue(Number(mirageBetaInput.value), MIRAGE_BETA_MIN, MIRAGE_BETA_MAX, fractal.mirageBeta)
        syncMirageInputs()
        redraw()
    })
    for (const input of [mirageAlphaInput, mirageBetaInput]) {
        input.addEventListener('keydown', (event) => {
            event.stopPropagation()
        })
    }
    gpuToggle.addEventListener('change', (event) => {
        fractal.useGpu = event.target.checked
        redraw()
    })
    fullScreenButton.addEventListener('click', (event) => {
        toggleFullScreen()
    })
    fullResToggle.addEventListener('change', (event) => {
        resizeToCanvasSize()
        redraw()
    })

    resetElement.addEventListener('click', (event) => {
        reset();
    })
    document.getElementById("lucky-button").addEventListener('click', (event) => {
        iFeelLucky();
    })
    document.getElementById("download-image").addEventListener('click', (event) => {
        downloadImage()
    })
    supersampleToggle.addEventListener('change', (event) => {
        fractal.supersample = event.target.checked
        // Smooth and supersample are mutually exclusive.
        if (fractal.supersample && fractal.smooth) {
            fractal.smooth = false
            smoothToggle.checked = false
        }
        fractal.resized()
        redraw()
    })
    document.getElementById("record-flight").addEventListener('click', (event) => {
        toggleFlightRecording()
    })
    const resumeFileInput = document.getElementById("resume-file")
    document.getElementById("resume-image").addEventListener('click', (event) => {
        resumeFileInput.click()
    })
    resumeFileInput.addEventListener('change', (event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = '' // allow picking the same file again later
        if (file) {
            resumeFromImage(file)
        }
    })
    appElement.addEventListener('keydown', (event) => {
        activeComponent.onKeydown(event)
    })
}

function clampMirageValue(value, min, max, fallback) {
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function syncMirageInputs() {
    // the slider clamps itself to its own range when the value was entered outside of it
    mirageAlphaSlider.value = fractal.mirageAlpha
    mirageBetaSlider.value = fractal.mirageBeta
    mirageAlphaInput.value = fractal.mirageAlpha
    mirageBetaInput.value = fractal.mirageBeta
}

function updateFractalControls() {
    fractalSelect.value = fractal.fractalType
    mirageParamsRow.hidden = fractal.fractalType !== 'mirage'
    multibrotParamsRow.hidden = fractal.fractalType !== 'multibrot'
    phoenixParamsRow.hidden = fractal.fractalType !== 'phoenix'
    absParamsRow.hidden = fractal.fractalType !== 'absfamily'
    gyreParamsRow.hidden = fractal.fractalType !== 'gyre'
    lyraParamsRow.hidden = fractal.fractalType !== 'lyra'
    juliaToggle.checked = fractal.juliaMode
    juliaToggle.disabled = fractal.fractalType === 'lyra' // Julia mode does not apply to Lyra
    juliaParamsRow.hidden = !fractal.juliaMode
    if (fractal.juliaMode && fractal.juliaSeed) {
        const re = juliaSeedRe(), im = juliaSeedIm()
        juliaXSlider.min = juliaSliderBase[0] - JULIA_SLIDER_SPAN
        juliaXSlider.max = juliaSliderBase[0] + JULIA_SLIDER_SPAN
        juliaISlider.min = juliaSliderBase[1] - JULIA_SLIDER_SPAN
        juliaISlider.max = juliaSliderBase[1] + JULIA_SLIDER_SPAN
        juliaXSlider.value = re
        juliaISlider.value = im
        juliaXInput.value = re
        juliaIInput.value = im
    }
    lyraSequenceInput.value = fractal.lyraSequence
    absVariantSelect.value = fractal.absVariant
    gyreThetaSlider.value = fractal.gyreTheta
    gyreThetaInput.value = fractal.gyreTheta
    gyreBetaSlider.value = fractal.gyreBeta
    gyreBetaInput.value = fractal.gyreBeta
    multibrotDegreeSlider.value = fractal.multibrotDegree
    multibrotDegreeLabel.innerText = `Degree: ${fractal.multibrotDegree}`
    phoenixQSlider.value = fractal.phoenixQ
    phoenixQInput.value = fractal.phoenixQ
    syncMirageInputs()
}

function applyHomeView(type) {
    const home = FRACTAL_HOME_VIEWS[type]
    fractal.setZoom(fxp.fromNumber(home[2] || 1))
    fractal.setCenter([fxp.fromNumber(home[0]), fxp.fromNumber(home[1])])
}

function juliaSeedRe() { return fractal.juliaSeed ? fractal.juliaSeed[0].toNumber() : 0 }
function juliaSeedIm() { return fractal.juliaSeed ? fractal.juliaSeed[1].toNumber() : 0 }
function recenterJuliaSliders() { juliaSliderBase = [juliaSeedRe(), juliaSeedIm()] }

function exitJuliaMode() {
    fractal.juliaMode = false
    fractal.juliaSeed = null
    fractal.preJuliaView = null
}

function reset() {
    // Reset only the view (zoom + pan) back to the home view, keeping the fractal choice, its
    // parameters, Julia mode/seed, palette and iterations.
    if (fractal.juliaMode) {
        // the Julia set lives in the z-plane, whose home view is the origin at zoom 1
        fractal.setZoom(fxp.fromNumber(1))
        fractal.setCenter([fxp.fromNumber(0), fxp.fromNumber(0)])
    } else {
        applyHomeView(fractal.fractalType)
    }
    redraw()
}

function iFeelLucky() {
    const favorite = favorites.getRandomFavorite()
    initFromParams(favorite)
    fractal.initPallete()
    redraw()
}

// Encodes the full state (location, fractal, parameters, palette) the same way the
// permalink does, so images and the url are interchangeable as restore points
function encodeParams() {
    let palette = {
        id: paletteSelector.palette.id,
        density: paletteSelector.density,
        rotate: paletteSelector.rotate,
    }
    if (paletteSelector.palette.isCustom()) {
        palette.id = undefined
        const exported = paletteSelector.palette.export()
        palette.colors = exported.colors
        palette.mirror = exported.mirror
    }
    const params = {
        center: fractal.center,
        zoom: fractal.zoom,
        max_iter: fractal.max_iter,
        smooth: fractal.smooth,
        fractal: fractal.fractalType,
        palette: palette
    }
    if (fractal.fractalType === 'mirage') {
        params.mirage = {alpha: fractal.mirageAlpha, beta: fractal.mirageBeta}
    }
    if (fractal.fractalType === 'multibrot') {
        params.multibrot = {degree: fractal.multibrotDegree}
    }
    if (fractal.fractalType === 'phoenix') {
        params.phoenix = {q: fractal.phoenixQ}
    }
    if (fractal.fractalType === 'absfamily') {
        params.absvariant = fractal.absVariant
    }
    if (fractal.fractalType === 'gyre') {
        params.gyre = {theta: fractal.gyreTheta, beta: fractal.gyreBeta}
    }
    if (fractal.fractalType === 'lyra') {
        params.lyra = {sequence: fractal.lyraSequence}
    }
    if (fractal.juliaMode) {
        params.julia = fractal.juliaSeed
    }
    return btoa(JSON.stringify(params))
}

function updatePermalink() {
    const url = new URL(window.location)
    url.searchParams.set('params', encodeParams())
    window.history.replaceState({}, '', url)
}

const PNG_PARAMS_KEYWORD = 'mandelbrotParams'

function imageFilename() {
    const zoomExp = fractal.zoom.bigIntValue().toString().length - 1
    let name = fractal.fractalType
    if (fractal.juliaMode) {
        name += '-julia'
    }
    return `${name}-1e${zoomExp}.png`
}

function downloadImage() {
    canvasElement.toBlob(async (blob) => {
        if (!blob) {
            return
        }
        const buffer = await blob.arrayBuffer()
        let bytes
        try {
            bytes = pngMeta.embedText(buffer, PNG_PARAMS_KEYWORD, encodeParams())
        } catch (e) {
            console.log(`Could not embed the location metadata: ${e}`)
            bytes = new Uint8Array(buffer) // download without metadata rather than not at all
        }
        const url = URL.createObjectURL(new Blob([bytes], {type: 'image/png'}))
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = imageFilename()
        anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 10000)
    }, 'image/png')
}

// Updates the flight recording progress bar. The rendering phase fills the first half,
// the encoding phase the second half. A null phase hides the bar.
function updateFlightProgress(phase, done, total) {
    const row = document.getElementById('flight-progress-row')
    const bar = document.getElementById('flight-progress-bar')
    if (!phase) {
        row.hidden = true
        bar.style.width = '0%'
        bar.innerText = ''
        return
    }
    row.hidden = false
    const offset = phase === 'encoding' ? 50 : 0
    const percent = Math.round(offset + (done / total) * 50)
    bar.style.width = `${percent}%`
    bar.innerText = `${phase} ${done}/${total}`
}

async function toggleFlightRecording() {
    if (fractal.recordingFlight) {
        fractal.flightCancelled = true
        return
    }
    if (fractal.zoom.bits() < 2) {
        alert('Zoom in somewhere first, then record the flight from 1x down to there.')
        return
    }
    const button = document.getElementById('record-flight')
    const originalZoom = fractal.zoom
    fractal.recordingFlight = true
    fractal.flightCancelled = false
    button.innerText = 'Cancel recording'
    updateFlightProgress('rendering', 0, 1)
    document.getElementById('progress-canvas').style.display = 'none'
    try {
        const video = await recordFlight(fractal, canvasElement, fxp, {
            onProgress: updateFlightProgress,
            isCancelled: () => fractal.flightCancelled,
        })
        if (video) {
            const url = URL.createObjectURL(video)
            const anchor = document.createElement('a')
            anchor.href = url
            const extension = video.type.includes('mp4') ? 'mp4' : 'webm'
            anchor.download = imageFilename().replace('.png', `-flight.${extension}`)
            anchor.click()
            setTimeout(() => URL.revokeObjectURL(url), 10000)
        }
    } catch (e) {
        console.log(`Flight recording failed: ${e}`)
        alert(`Could not record the flight: ${e.message}`)
    } finally {
        fractal.recordingFlight = false
        button.innerText = 'Record flight'
        updateFlightProgress(null)
        fractal.setZoom(originalZoom)
        redraw()
    }
}

async function resumeFromImage(file) {
    const params = pngMeta.extractText(await file.arrayBuffer(), PNG_PARAMS_KEYWORD)
    if (!params) {
        alert('No fractal location found in this image. Only images saved with the Download button can be resumed.')
        return
    }
    try {
        initFromParams(params)
    } catch (e) {
        console.log(`Could not restore from image: ${e}`)
        alert('The location data in this image could not be read.')
        return
    }
    fractal.initPallete()
    updatePermalink()
    redraw()
}

function initUI() {
    paletteSelector.init();
}

// on load, check if there is a permalink in the url
function init() {
    initUI()
    if (initialUrlParams) {
        initFromParams(initialUrlParams)
    }
    // Smooth and supersample are mutually exclusive; supersample is the
    // default render mode when smooth is off. It isn't stored in the
    // permalink, so derive it from the (possibly restored) smooth value
    // BEFORE onResize so the offscreens are sized for it.
    fractal.supersample = !fractal.smooth
    // resizeTmpCanvas()
    onResize()
    iterationsElement.value = fractal.max_iter
    smoothToggle.checked = fractal.smooth
    supersampleToggle.checked = fractal.supersample
    updateFractalControls()
    fractal.initPallete()
    for (let component of components) {
        component.init()
    }
    showSettingsContainer()
    initListeners()
    // small hook for tests and power users
    window.mandelbrotApp = {
        fractal,
        recordFlight: (callbacks) => recordFlight(fractal, canvasElement, fxp, callbacks),
        updateFlightProgress,
    }
    redraw()
}

function initFromParams(params) {
    const p = JSON.parse(atob(params))
    fractal.fractalType = FRACTAL_HOME_VIEWS[p.fractal] ? p.fractal : 'mandelbrot'
    fractal.mirageAlpha = clampMirageValue(Number(p.mirage && p.mirage.alpha), MIRAGE_ALPHA_MIN, MIRAGE_ALPHA_MAX, MIRAGE_DEFAULT_ALPHA)
    fractal.mirageBeta = clampMirageValue(Number(p.mirage && p.mirage.beta), MIRAGE_BETA_MIN, MIRAGE_BETA_MAX, MIRAGE_DEFAULT_BETA)
    fractal.multibrotDegree = Math.round(clampMirageValue(Number(p.multibrot && p.multibrot.degree), 2, 8, MULTIBROT_DEFAULT_DEGREE))
    fractal.phoenixQ = clampMirageValue(Number(p.phoenix && p.phoenix.q), PHOENIX_Q_MIN, PHOENIX_Q_MAX, PHOENIX_DEFAULT_Q)
    fractal.absVariant = ABS_VARIANTS[p.absvariant] ? p.absvariant : ABS_DEFAULT_VARIANT
    fractal.gyreTheta = clampMirageValue(Number(p.gyre && p.gyre.theta), -180, 180, GYRE_DEFAULT_THETA)
    fractal.gyreBeta = clampMirageValue(Number(p.gyre && p.gyre.beta), 0, 20, GYRE_DEFAULT_BETA)
    fractal.lyraSequence = cleanLyraSequence(p.lyra && p.lyra.sequence)
    if (p.julia) {
        fractal.juliaMode = true
        fractal.juliaSeed = p.julia.map(fxp.fromJSON)
        fractal.preJuliaView = null
        recenterJuliaSliders()
    } else {
        exitJuliaMode()
    }
    // set max_iter/smooth before setZoom: _updatePrecision (high-degree multibrot) depends on max_iter
    fractal.max_iter = p.max_iter
    fractal.smooth = p.smooth
    fractal.setZoom(fxp.fromJSON(p.zoom))
    fractal.setCenter(p.center.map(fxp.fromJSON))
    if (p.palette) {
        if (p.palette.colors) {
            paletteSelector.setEmbeddedPalette(p.palette.colors, p.palette.mirror)
        } else {
            paletteSelector.setPalette(palette.getPalette(p.palette.id))
        }
        paletteSelector.setDensity(p.palette.density)
        paletteSelector.setRotate(p.palette.rotate)
    }
    iterationsElement.value = fractal.max_iter
    smoothToggle.checked = fractal.smooth
    updateFractalControls()
}

class SettingsComponent {
    constructor() {
    }

    init() {
    }

    show() {
        const settingsContainer = document.getElementById('settings-container')
        settingsContainer.hidden = false
    }

    hide() {
        const settingsContainer = document.getElementById('settings-container')
        settingsContainer.hidden = true
    }

    onKeydown(event) {
        if (event.key === 'r') {
            // console.log('redraw')
            redraw(true)
        }
        if (event.key === 'Backspace') {
            reset()
        }

        if (event.key === '+' || event.key === '=') {
            updateIterations(100)
        }
        if (event.key === '-') {
            updateIterations(-100)
        }
        if (event.key === 's') {
            fractal.smooth = !fractal.smooth
            smoothToggle.checked = fractal.smooth
            // Mutually exclusive with supersample.
            if (fractal.smooth && fractal.supersample) {
                fractal.supersample = false
                supersampleToggle.checked = false
                fractal.resized()
            }
            redraw()
        }
        if (event.key === 'f') {
            toggleFullScreen()
        }
    }
}

class CustomPaletteComponent {
    constructor() {
        this.draggedElement = null;
        this.dropIndicator = document.createElement('div');
        this.dropIndicator.className = 'custom-palette-drop-indicator';
    }

    init() {
        const saveButton = document.getElementById('custom-palette-save')
        saveButton.addEventListener('click', this.save.bind(this))

        const cancelButton = document.getElementById('custom-palette-cancel')
        cancelButton.addEventListener('click', this.cancel.bind(this))

        const addColorButton = document.getElementById('add-custom-palette-color');
        addColorButton.addEventListener('click', () => {
            this.addColorInput('#ffffff');
            this.updated();
        });

        const mirrorCheckbox = document.getElementById('custom-palette-mirror');
        if (mirrorCheckbox) {
            mirrorCheckbox.addEventListener('change', () => {
                this.updated();
            });
        }

        const deleteButton = document.getElementById('custom-palette-delete');
        deleteButton.addEventListener('click', () => {
            if (!this.editingId) return;
            const paletteObj = palette.getPalette(this.editingId);
            if (!paletteObj) return;
            if (!confirm(`Delete palette "${paletteObj.name}"?`)) return;
            // To preserve the image after deleting the current palette, we set it as embedded palette
            const exported = paletteObj.export ? paletteObj.export() : { colors: paletteObj.colors, mirror: paletteObj.mirror };
            palette.deleteCustomPalette(this.editingId);
            paletteSelector.init();
            paletteSelector.setEmbeddedPalette(exported.colors, exported.mirror);
            this.previousPalette = null;
            this.editingId = null;
            showSettingsContainer();
        });
    }

    show() {
        this.previousPalette = paletteSelector.palette
        const customContainer = document.getElementById('custom-palette-container')
        customContainer.hidden = false

        const currentPalette = paletteSelector.palette
        let basePalette = palette.MANDELBROT
        if (currentPalette instanceof palette.IndexedPalette) {
            basePalette = currentPalette
        }
        let paletteName = basePalette.name
        if (!this.editingId) {
            const basename = basePalette.name.replace(/ Copy( \(\d+\))?$/, '')
            let copyIndex = 1
            const palettes = palette.palettes();
            while (true) {
                const testName = `${basename} Copy${copyIndex > 1 ? ' (' + copyIndex + ')' : ''}`
                const exists = palettes.some(p => p.name === testName)
                if (!exists) {
                    paletteName = testName
                    break
                }
                copyIndex++
            }
        }
        document.getElementById('custom-palette-name').value = paletteName

        const colorsDiv = document.getElementById('custom-palette-colors');
        colorsDiv.innerHTML = '';
        basePalette.paletteColors.forEach((color) => {
            this.addColorInput(color, colorsDiv);
        });
        document.getElementById('custom-palette-mirror').checked = basePalette.mirror

        // Show delete button only if editing an existing custom palette
        const deleteButton = document.getElementById('custom-palette-delete');
        if (this.editingId && palette.getPalette(this.editingId)?.isCustom?.()) {
            deleteButton.style.display = '';
        } else {
            deleteButton.style.display = 'none';
        }

        this.updated()
    }

    addColorInput(color, parentDiv) {
        const colorsDiv = parentDiv || document.getElementById('custom-palette-colors');
        const wrapper = document.createElement('div');
        wrapper.className = 'input-group mb-1 custom-palette-row';
        wrapper.draggable = true;

        // Drag handle
        const handle = document.createElement('span');
        handle.className = 'input-group-text custom-palette-drag-handle';
        handle.title = 'Drag to reorder';
        handle.innerHTML = '&#x2630;'; // Unicode hamburger icon
        handle.setAttribute('tabindex', '0');
        wrapper.appendChild(handle);

        // Drag events
        handle.addEventListener('mousedown', (e) => {
            wrapper.classList.add('dragging');
        });
        handle.addEventListener('mouseup', (e) => {
            wrapper.classList.remove('dragging');
        });
        wrapper.addEventListener('dragstart', (e) => {
            this.draggedElement = wrapper;
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(() => { wrapper.classList.add('hidden-drag'); }, 0);
        });
        wrapper.addEventListener('dragend', (e) => {
            this.draggedElement = null;
            wrapper.classList.remove('hidden-drag');
            wrapper.classList.remove('dragging');
            this.removeDropIndicator();
        });
        wrapper.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            // Show drop indicator above or below based on mouse position
            const rect = wrapper.getBoundingClientRect();
            const offset = e.clientY - rect.top;
            const insertAbove = offset < rect.height / 2;
            this.showDropIndicator(colorsDiv, wrapper, insertAbove);
        });
        wrapper.addEventListener('dragleave', (e) => {
            // Only remove if leaving the row entirely
            if (!wrapper.contains(e.relatedTarget)) {
                this.removeDropIndicator();
            }
        });
        wrapper.addEventListener('drop', (e) => {
            e.preventDefault();
            if (this.draggedElement && this.draggedElement !== wrapper) {
                const children = Array.from(colorsDiv.children).filter(el => !el.classList.contains('custom-palette-drop-indicator'));
                const insertAbove = this.dropIndicator.parentNode === colorsDiv && this.dropIndicator.nextSibling === wrapper;
                if (insertAbove) {
                    colorsDiv.insertBefore(this.draggedElement, wrapper);
                } else {
                    colorsDiv.insertBefore(this.draggedElement, wrapper.nextSibling);
                }
                this.updated();
            }
            this.removeDropIndicator();
            this.updated();
        });

        // Color input
        let rgb = color;
        let weight = 1;
        if (Array.isArray(color)) {
            rgb = `#${((1 << 24) + (color[0] << 16) + (color[1] << 8) + color[2]).toString(16).slice(1)}`;
            weight = color.length > 3 ? color[3] : 1;
        }
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = rgb;
        colorInput.className = 'form-control form-control-color custom-palette-color-input';
        colorInput.title = rgb;
        colorInput.addEventListener('input', () => {
            this.updated();
        });

        // Weight input
        const weightInput = document.createElement('input');
        weightInput.type = 'number';
        // weightInput.min = '0.01';
        weightInput.step = '0.5';
        weightInput.value = String(weight)
        weightInput.className = 'form-control form-control-sm';
        weightInput.id = 'custom-palette-weight-input'
        weightInput.title = 'Weight';
        weightInput.addEventListener('input', () => {
            if (parseFloat(weightInput.value) <= 0 || isNaN(parseFloat(weightInput.value))) {
                weightInput.value = "1";
            }
            this.updated();
        });
        const weightLabel = document.createElement('span');
        weightLabel.className = 'input-group-text';
        weightLabel.textContent = 'w';
        weightLabel.title = 'Weight';

        // Remove button
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn-outline-danger btn-sm custom-palette-remove-btn';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
            colorsDiv.removeChild(wrapper);
            this.updated();
        });

        wrapper.appendChild(colorInput);
        wrapper.appendChild(weightLabel);
        wrapper.appendChild(weightInput);
        wrapper.appendChild(removeBtn);
        colorsDiv.appendChild(wrapper);
    }

    showDropIndicator(colorsDiv, wrapper, insertAbove) {
        this.removeDropIndicator();
        if (insertAbove) {
            colorsDiv.insertBefore(this.dropIndicator, wrapper);
        } else {
            colorsDiv.insertBefore(this.dropIndicator, wrapper.nextSibling);
        }
    }

    removeDropIndicator() {
        if (this.dropIndicator.parentNode) {
            this.dropIndicator.parentNode.removeChild(this.dropIndicator);
        }
    }

    updated() {
        const customPalette = this.toPalette()
        paletteSelector.setAnonymousPalette(customPalette)
        paletteSelector.notifyListeners()
        const previewCanvas = document.getElementById('custom-palette-preview');
        if (previewCanvas) {
            const ctx = previewCanvas.getContext('2d');
            ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
            for (let x = 0; x < previewCanvas.width; x++) {
                let color = customPalette.getColor(x / previewCanvas.width * 100, 0);
                ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
                ctx.fillRect(x, 0, 1, previewCanvas.height);
            }
        }
    }

    toPalette() {
        const colorRows = document.querySelectorAll('#custom-palette-colors .custom-palette-row');
        const colors = Array.from(colorRows).map(row => {
            const colorInput = row.querySelector('input[type="color"]');
            const weightInput = row.querySelector('input[type="number"]');
            const hex = colorInput.value;
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            let w = parseFloat(weightInput.value);
            if (!(w > 0)) w = 1;
            return [r, g, b, w];
        });
        const name = document.getElementById('custom-palette-name').value || 'Custom Palette';
        const mirrored = document.getElementById('custom-palette-mirror').checked;
        return palette.createPaletteFromColors('<tmp>', name, colors, mirrored);
    }

    save() {
        const customPalette = this.toPalette()
        if (this.editingId) {
            const exported = customPalette.export()
            palette.updateCustomPalette(this.editingId, exported)
            paletteSelector.init()
            paletteSelector.setPalette(palette.getPalette(this.editingId))
            this.previousPalette = null
        } else {
            const exported = customPalette.export()
            palette.addCustomPalette(exported)
            paletteSelector.init()
            paletteSelector.setPalette(customPalette)
            this.previousPalette = null
        }
        showSettingsContainer()
    }

    cancel() {
        showSettingsContainer()
    }

    hide() {
        this.editingId = null
        const customContainer = document.getElementById('custom-palette-container')
        customContainer.hidden = true
        if (this.previousPalette) {
            paletteSelector.setPalette(this.previousPalette)
        }
        paletteSelector.notifyListeners()
    }

    onKeydown(event) {
        if (event.key === 'Escape') {
            showSettingsContainer();
        }
    }
}

let activeComponent = null;
const settingsComponent = new SettingsComponent();
const customPaletteComponent = new CustomPaletteComponent();
const components = [settingsComponent, customPaletteComponent];

function showSettingsContainer() {
    showComponent(settingsComponent)
}

function showCustomPaletteContainer() {
    showComponent(customPaletteComponent)
}

function showComponent(component) {
    if (activeComponent) {
        activeComponent.hide()
    }
    activeComponent = component
    component.show()
}

window.onload = init
