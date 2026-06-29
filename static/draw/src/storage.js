// localStorage persistence + file import/export.

const KEY = 'infinizoom.doc.v2';

export function saveLocal(scene, camera) {
  try {
    const payload = JSON.stringify({ doc: scene.toJSON(), camera: camera.serialize(), savedAt: Date.now() });
    localStorage.setItem(KEY, payload);
    return true;
  } catch (e) {
    console.warn('saveLocal failed', e);
    return false;
  }
}

export function loadLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('loadLocal failed', e);
    return null;
  }
}

export function clearLocal() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function downloadJSON(scene, filename = 'drawing.json') {
  const blob = new Blob([JSON.stringify(scene.toJSON(), null, 2)], { type: 'application/json' });
  triggerDownload(blob, filename);
}

export function downloadPNG(canvas, filename = 'drawing.png') {
  canvas.toBlob(blob => { if (blob) triggerDownload(blob, filename); }, 'image/png');
}

export function downloadSVG(svgString, filename = 'drawing.svg') {
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  triggerDownload(blob, filename);
}

export function downloadGIF(bytes, filename = 'animation.gif') {
  const blob = new Blob([bytes], { type: 'image/gif' });
  triggerDownload(blob, filename);
}

/** Download any canvas as a PNG (used for the sprite-sheet export). */
export function downloadCanvasPNG(canvas, filename = 'spritesheet.png') {
  canvas.toBlob(blob => { if (blob) triggerDownload(blob, filename); }, 'image/png');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileAsJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(reader.result)); }
      catch (e) { reject(e); }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
