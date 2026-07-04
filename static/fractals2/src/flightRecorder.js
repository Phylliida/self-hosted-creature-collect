// flightRecorder.js — record a zoom flight (from a shallow start radius down to the
// current view) as a webm/mp4 video. Ported from the old implementation (Spawn 42).
//
// Two phases, because MediaRecorder records in REAL TIME while deep frames can take
// seconds to render: (1) render every frame and keep it as a compressed image blob;
// (2) replay the frames onto the canvas at a fixed frame rate while a MediaRecorder
// captures the replay — even pacing regardless of per-frame render time.
//
// The caller supplies `renderFrame(radius)` (set the view to that radius at the fixed
// full-precision center and resolve when the sharp frame is on the canvas) so this
// module stays decoupled from the viewer. Centers are full-precision BigInts in the
// new engine, so — unlike the old FxP version — no per-frame re-anchoring is needed.

const FPS = 30;
const FRAMES_PER_DOUBLING = 6;
const MIN_FRAMES = 60;
const MAX_FRAMES = 1200;

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || null;
}

// How many frames a flight to `targetRadius` from `startRadius` will render (for a
// caller that wants to warn before committing). Mirrors recordFlight's own maths.
export function flightFrameCount(startRadius, targetRadius) {
  const doublings = Math.max(1, Math.log2(startRadius / targetRadius));
  return Math.max(MIN_FRAMES, Math.min(MAX_FRAMES, Math.round(doublings * FRAMES_PER_DOUBLING)));
}

/**
 * @param {HTMLCanvasElement} canvas  the display canvas (2-D)
 * @param {{ startRadius:number, targetRadius:number,
 *           renderFrame:(radius:number)=>Promise<void>,
 *           onProgress?:(phase:string, done:number, total:number)=>void,
 *           isCancelled?:()=>boolean }} opts
 * @returns {Promise<Blob|null>} the video, or null if cancelled
 */
export async function recordFlight(canvas, opts) {
  const { startRadius, targetRadius, renderFrame } = opts;
  const onProgress = opts.onProgress || (() => {});
  const isCancelled = opts.isCancelled || (() => false);

  const mimeType = pickMimeType();
  if (!mimeType) throw new Error('video recording (MediaRecorder) is not supported in this browser');

  const frames = flightFrameCount(startRadius, targetRadius);
  const ratio = targetRadius / startRadius;   // < 1 (we zoom IN across the flight)

  // Phase 1 — render each frame, keep it as a compressed image blob.
  const frameBlobs = [];
  for (let i = 0; i < frames; i++) {
    if (isCancelled()) return null;
    const t = frames === 1 ? 1 : i / (frames - 1);
    const radius = i === frames - 1 ? targetRadius : startRadius * Math.pow(ratio, t);
    await renderFrame(radius);
    if (isCancelled()) return null;
    let blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.92));
    if (!blob) blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('could not capture a frame from the canvas');
    frameBlobs.push(blob);
    onProgress('rendering', i + 1, frames);
  }

  // Phase 2 — replay the frames at a fixed rate and record the replay.
  const stream = canvas.captureStream(FPS);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12000000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.start(1000);
  const ctx = canvas.getContext('2d');
  const frameInterval = 1000 / FPS;
  let nextFrameAt = performance.now();
  for (let i = 0; i < frameBlobs.length; i++) {
    if (isCancelled()) break;
    const bitmap = await createImageBitmap(frameBlobs[i]);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    onProgress('encoding', i + 1, frameBlobs.length);
    nextFrameAt += frameInterval;
    const wait = nextFrameAt - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());

  if (isCancelled()) return null;
  return new Blob(chunks, { type: mimeType });
}
