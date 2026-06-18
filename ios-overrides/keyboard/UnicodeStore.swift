import Foundation

/// Read-only access to the precompiled Unicode dataset produced by
/// `scripts/build-unicode-data.py`. The three resource files are bundled into
/// the keyboard extension under `UnicodeData/`:
///
///   blocks.json  Browse hierarchy: block -> subgroup -> [first, count].
///   chars.idx    Fixed 12-byte little-endian records, one per assigned char
///                in browse order: codepoint(u32), nameOffset(u32),
///                nameLen(u16), flags(u16).
///   names.blob   Concatenated UTF-8 display names, sliced by offset/len.
///
/// `chars.idx` and `names.blob` are memory-mapped (`.mappedIfSafe`) so the
/// keyboard's tight (~50 MB) memory budget is never spent holding the whole
/// dataset — the OS pages in only the bytes actually touched.
final class UnicodeStore {

    struct Subgroup: Decodable { let name: String; let first: Int; let count: Int }
    struct Block: Decodable {
        let name: String
        let start: Int
        let end: Int
        let first: Int
        let count: Int
        let subgroups: [Subgroup]
    }

    let blocks: [Block]
    let count: Int

    private let idx: Data    // chars.idx, memory-mapped
    private let names: Data  // names.blob, memory-mapped

    /// nil only if the bundled resources are missing/corrupt.
    static let shared: UnicodeStore? = UnicodeStore()

    private struct Manifest: Decodable { let version: Int; let count: Int; let blocks: [Block] }

    private init?() {
        let bundle = Bundle(for: UnicodeStore.self)
        func url(_ name: String, _ ext: String) -> URL? {
            bundle.url(forResource: name, withExtension: ext, subdirectory: "UnicodeData")
                ?? bundle.url(forResource: name, withExtension: ext)
        }
        guard
            let blocksURL = url("blocks", "json"),
            let idxURL = url("chars", "idx"),
            let namesURL = url("names", "blob"),
            let blocksData = try? Data(contentsOf: blocksURL),
            let manifest = try? JSONDecoder().decode(Manifest.self, from: blocksData),
            let idxData = try? Data(contentsOf: idxURL, options: .mappedIfSafe),
            let namesData = try? Data(contentsOf: namesURL, options: .mappedIfSafe)
        else { return nil }
        self.blocks = manifest.blocks
        self.count = manifest.count
        self.idx = idxData
        self.names = namesData
    }

    private static let recordSize = 12

    // MARK: - Per-character access (infrequent; plain Data subscripting is fine)

    private func u32(_ d: Data, _ o: Int) -> UInt32 {
        UInt32(d[o]) | (UInt32(d[o + 1]) << 8) | (UInt32(d[o + 2]) << 16) | (UInt32(d[o + 3]) << 24)
    }
    private func u16(_ d: Data, _ o: Int) -> UInt16 {
        UInt16(d[o]) | (UInt16(d[o + 1]) << 8)
    }

    /// Codepoint at the given global browse index.
    func codepoint(_ i: Int) -> UInt32 {
        u32(idx, i * Self.recordSize)
    }

    /// Display name (e.g. "LATIN SMALL LETTER A") at the given index.
    func name(_ i: Int) -> String {
        let base = i * Self.recordSize
        let off = Int(u32(idx, base + 4))
        let len = Int(u16(idx, base + 8))
        guard len > 0, off + len <= names.count else { return "" }
        return String(decoding: names.subdata(in: off ..< (off + len)), as: UTF8.self)
    }

    /// Renderable string for a codepoint (replacement char for invalid scalars).
    func string(forCodepoint cp: UInt32) -> String {
        if let scalar = Unicode.Scalar(cp) { return String(scalar) }
        return "\u{FFFD}"
    }

    // MARK: - Search

    /// Substring search over display names (case-insensitive). Names in the
    /// dataset are uppercase ASCII, so we uppercase the query and scan the raw
    /// bytes — no per-record String allocation across all ~40k entries.
    /// Returns global browse indices, capped at `limit`.
    func search(_ query: String, limit: Int = 400) -> [Int] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        let q = Array(trimmed.uppercased().utf8)
        guard !q.isEmpty else { return [] }

        var out: [Int] = []
        idx.withUnsafeBytes { (ibRaw: UnsafeRawBufferPointer) in
            names.withUnsafeBytes { (nbRaw: UnsafeRawBufferPointer) in
                guard
                    let ibBase = ibRaw.baseAddress?.assumingMemoryBound(to: UInt8.self),
                    let nbBase = nbRaw.baseAddress?.assumingMemoryBound(to: UInt8.self)
                else { return }
                var i = 0
                while i < count && out.count < limit {
                    let base = i * Self.recordSize
                    let off = Int(ibBase[base + 4]) | (Int(ibBase[base + 5]) << 8)
                        | (Int(ibBase[base + 6]) << 16) | (Int(ibBase[base + 7]) << 24)
                    let len = Int(ibBase[base + 8]) | (Int(ibBase[base + 9]) << 8)
                    if Self.contains(nbBase, off, len, q) { out.append(i) }
                    i += 1
                }
            }
        }
        return out
    }

    private static func contains(_ p: UnsafePointer<UInt8>, _ off: Int, _ len: Int, _ q: [UInt8]) -> Bool {
        let m = q.count
        if m > len { return false }
        let last = off + len - m
        var i = off
        while i <= last {
            var k = 0
            while k < m && p[i + k] == q[k] { k += 1 }
            if k == m { return true }
            i += 1
        }
        return false
    }
}
