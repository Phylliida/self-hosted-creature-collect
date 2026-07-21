// PackReader: random access into a creature content pack (pack.bin).
//
// The pack is a single binary file (see content_pack.py for the format):
// an 8-byte magic, u32 version, u64 TOC length, a JSON TOC mapping
// logical bundled-data paths to {offset, length, sha256}, then the
// concatenated entry bytes. The client stores the whole blob as-is
// (grab-and-store — no processing) and serves exactly the asset it
// needs via Blob.slice — O(1) per lookup.
//
// Headless-safe: works under Node (tests drive it with fs-backed Blobs)
// as long as Blob/fetch-level primitives exist. No DOM access.
//
//   const reader = await PackReader.open(blob);
//   reader.has('types.json')                 -> bool
//   reader.list('sprites/4/')                -> [paths...]
//   await reader.get('types.json')           -> Blob (slice)
//   await reader.text('types.json')          -> string
//   await reader.json('types.json')          -> parsed
//   await reader.getVerified('types.json')   -> Blob | null (sha256-checked)

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['pack-reader.js'] = SCRIPT_VERSION;

  const MAGIC = 'CCPACK01';
  const FORMAT_VERSION = 1;
  const HEADER_BYTES = 20;  // magic(8) + version(u32) + tocLen(u64)

  async function _open(blob) {
    if (!blob || typeof blob.slice !== 'function') {
      throw new Error('PackReader.open: expected a Blob/File');
    }
    const head = new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer());
    if (head.length < HEADER_BYTES) throw new Error('not a content pack (too small)');
    const magic = String.fromCharCode.apply(null, Array.from(head.slice(0, 8)));
    if (magic !== MAGIC) throw new Error('not a content pack (bad magic)');
    const view = new DataView(head.buffer);
    const version = view.getUint32(8, true);
    if (version !== FORMAT_VERSION) {
      throw new Error('unsupported pack format version ' + version);
    }
    // u64 LE — safe up to 2^53, far beyond any pack size.
    const tocLen = view.getUint32(12, true) + view.getUint32(16, true) * 0x100000000;
    const tocText = await blob.slice(HEADER_BYTES, HEADER_BYTES + tocLen).text();
    const toc = JSON.parse(tocText);
    return new PackReader(blob, toc);
  }

  function PackReader(blob, toc) {
    this._blob = blob;
    this.toc = toc;
    this.entries = toc.entries || {};
  }

  PackReader.prototype.has = function (path) {
    return Object.prototype.hasOwnProperty.call(this.entries, path);
  };

  PackReader.prototype.list = function (prefix) {
    const out = [];
    for (const k of Object.keys(this.entries)) {
      if (!prefix || k.startsWith(prefix)) out.push(k);
    }
    return out.sort();
  };

  // Raw slice — no integrity check (fast path; the whole-file hash in
  // pack.json covers download integrity).
  PackReader.prototype.get = function (path) {
    const e = this.entries[path];
    if (!e) return null;
    return this._blob.slice(e.offset, e.offset + e.length);
  };

  PackReader.prototype.text = async function (path) {
    const b = this.get(path);
    return b ? b.text() : null;
  };

  PackReader.prototype.json = async function (path) {
    const t = await this.text(path);
    return t == null ? null : JSON.parse(t);
  };

  // Slice + verify the entry's sha256 (when WebCrypto is available).
  // Returns the Blob, or null on missing entry / hash mismatch.
  PackReader.prototype.getVerified = async function (path) {
    const b = this.get(path);
    if (!b) return null;
    const subtle = (global.crypto && global.crypto.subtle) || null;
    if (!subtle) return b;  // no crypto available — unverified passthrough
    const digest = await subtle.digest('SHA-256', await b.arrayBuffer());
    const hex = Array.from(new Uint8Array(digest))
      .map((x) => x.toString(16).padStart(2, '0')).join('');
    return hex === this.entries[path].sha256 ? b : null;
  };

  global.PackReader = { open: _open, MAGIC, FORMAT_VERSION };

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
