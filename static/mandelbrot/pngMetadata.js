/**
 * Minimal PNG tEXt metadata reading and writing, used to embed the fractal location in
 * downloaded images so that they can be restored by uploading the image again.
 *
 * A PNG file is an 8 byte signature followed by chunks of (4 byte big-endian length,
 * 4 byte type, data, 4 byte CRC over type+data). A tEXt chunk contains a latin-1 keyword,
 * a null byte and latin-1 text. The chunk is inserted directly after the IHDR chunk,
 * which the spec guarantees to be first.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
        }
        table[n] = c >>> 0
    }
    return table
})()

function crc32(bytes, start, end) {
    let c = 0xFFFFFFFF
    for (let i = start; i < end; i++) {
        c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
    }
    return (c ^ 0xFFFFFFFF) >>> 0
}

function toBytes(buffer) {
    return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
}

function isPng(bytes) {
    return bytes.length > 33 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

/**
 * Returns a new Uint8Array of the png with a tEXt chunk (keyword and text, both latin-1
 * safe strings) inserted after the IHDR chunk.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} keyword
 * @param {string} text
 * @returns {Uint8Array}
 */
export function embedText(buffer, keyword, text) {
    const bytes = toBytes(buffer)
    if (!isPng(bytes)) {
        throw new Error('not a png file')
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const ihdrLength = view.getUint32(8)
    const insertAt = 8 + 12 + ihdrLength

    const data = new Uint8Array(keyword.length + 1 + text.length)
    for (let i = 0; i < keyword.length; i++) {
        data[i] = keyword.charCodeAt(i) & 0xFF
    }
    data[keyword.length] = 0
    for (let i = 0; i < text.length; i++) {
        data[keyword.length + 1 + i] = text.charCodeAt(i) & 0xFF
    }

    const chunk = new Uint8Array(12 + data.length)
    const chunkView = new DataView(chunk.buffer)
    chunkView.setUint32(0, data.length)
    chunk[4] = 0x74 // t
    chunk[5] = 0x45 // E
    chunk[6] = 0x58 // X
    chunk[7] = 0x74 // t
    chunk.set(data, 8)
    chunkView.setUint32(8 + data.length, crc32(chunk, 4, 8 + data.length))

    const result = new Uint8Array(bytes.length + chunk.length)
    result.set(bytes.subarray(0, insertAt), 0)
    result.set(chunk, insertAt)
    result.set(bytes.subarray(insertAt), insertAt + chunk.length)
    return result
}

/**
 * Returns the text of the first tEXt chunk with the given keyword, or null if the buffer
 * is not a png or has no such chunk.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} keyword
 * @returns {string|null}
 */
export function extractText(buffer, keyword) {
    const bytes = toBytes(buffer)
    if (!isPng(bytes)) {
        return null
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let pos = 8
    while (pos + 12 <= bytes.length) {
        const length = view.getUint32(pos)
        const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
        if (type === 'tEXt' && pos + 12 + length <= bytes.length) {
            const data = bytes.subarray(pos + 8, pos + 8 + length)
            const sep = data.indexOf(0)
            if (sep > 0) {
                let kw = ''
                for (let i = 0; i < sep; i++) {
                    kw += String.fromCharCode(data[i])
                }
                if (kw === keyword) {
                    let text = ''
                    for (let i = sep + 1; i < data.length; i++) {
                        text += String.fromCharCode(data[i])
                    }
                    return text
                }
            }
        }
        if (type === 'IEND') {
            break
        }
        pos += 12 + length
    }
    return null
}
