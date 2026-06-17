/**
 * Records a zoom flight from zoom 1 down to the current view as a webm video.
 *
 * Works in two phases because MediaRecorder records in real time while deep frames can take
 * seconds to render: first every frame is rendered (via fractal.renderOnce) and captured as a
 * compressed image blob, then the frames are replayed onto the canvas at a fixed frame rate
 * while a MediaRecorder records the replay. This gives even pacing regardless of how long the
 * individual frames took to render.
 */

const FPS = 30
const FRAMES_PER_DOUBLING = 6
const MIN_FRAMES = 60
const MAX_FRAMES = 1200

function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') {
        return null
    }
    const candidates = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        'video/mp4',
    ]
    return candidates.find(c => MediaRecorder.isTypeSupported(c)) || null
}

/**
 * @param fractal the Mandelbrot app object (zoom/setZoom/renderOnce)
 * @param {HTMLCanvasElement} canvas
 * @param fxp the fixed point module
 * @param {{onProgress: function(string, number, number), isCancelled: function(): boolean}} callbacks
 *        onProgress receives (phase, done, total) with phase 'rendering' or 'encoding'
 * @returns {Promise<Blob|null>} the video, or null when cancelled
 */
export async function recordFlight(fractal, canvas, fxp, callbacks) {
    const onProgress = callbacks.onProgress || (() => {})
    const isCancelled = callbacks.isCancelled || (() => false)

    const mimeType = pickMimeType()
    if (!mimeType) {
        throw new Error('video recording (MediaRecorder) is not supported in this browser')
    }

    const targetZoom = fractal.zoom
    // The full-precision target center. setZoom(1) drops the working precision to ~58 bits and
    // re-scales the stored center down to it, discarding the ~hundreds of bits that locate a deep
    // target — so without restoring it each frame the flight zooms back in to the wrong place.
    const targetCenter = [fractal.center[0], fractal.center[1]]
    const doublings = Math.max(1, targetZoom.bits())
    const frames = Math.max(MIN_FRAMES, Math.min(MAX_FRAMES, Math.round(doublings * FRAMES_PER_DOUBLING)))
    const factor = Math.pow(2, doublings / frames)

    // phase 1: render the frames and keep them as compressed images
    const frameBlobs = []
    fractal.setZoom(fxp.fromNumber(1, fractal.precision))
    for (let i = 0; i < frames; i++) {
        if (isCancelled()) {
            return null
        }
        if (i === frames - 1) {
            fractal.setZoom(targetZoom) // land exactly on the recorded view
        } else if (i > 0) {
            fractal.setZoom(fractal.zoom.multiply(fxp.fromNumber(factor, fractal.precision)))
        }
        // Re-anchor on the full-precision center: setZoom just truncated it to this frame's
        // precision, which would compound into drift at deep zoom (each frame must derive from the
        // true target, not the previous truncation).
        fractal.setCenter([targetCenter[0], targetCenter[1]])
        await fractal.renderOnce()
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.92))
        if (!blob) {
            throw new Error('could not capture a frame from the canvas')
        }
        frameBlobs.push(blob)
        onProgress('rendering', i + 1, frames)
    }

    // phase 2: replay the frames at a fixed rate and record the replay
    const stream = canvas.captureStream(FPS)
    const recorder = new MediaRecorder(stream, {mimeType: mimeType, videoBitsPerSecond: 12000000})
    const chunks = []
    recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            chunks.push(event.data)
        }
    }
    const stopped = new Promise(resolve => recorder.onstop = resolve)
    recorder.start(1000)
    const context = canvas.getContext('2d')
    const frameInterval = 1000 / FPS
    let nextFrameAt = performance.now()
    for (let i = 0; i < frameBlobs.length; i++) {
        if (isCancelled()) {
            break
        }
        const bitmap = await createImageBitmap(frameBlobs[i])
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        bitmap.close()
        onProgress('encoding', i + 1, frameBlobs.length)
        nextFrameAt += frameInterval
        const wait = nextFrameAt - performance.now()
        if (wait > 0) {
            await new Promise(resolve => setTimeout(resolve, wait))
        }
    }
    recorder.stop()
    await stopped
    stream.getTracks().forEach(track => track.stop())

    if (isCancelled()) {
        return null
    }
    return new Blob(chunks, {type: mimeType})
}
