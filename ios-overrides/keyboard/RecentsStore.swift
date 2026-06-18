import Foundation

/// Recents + favorites for the keyboard, stored privately in the extension's
/// own `UserDefaults` (keyboard-only — not shared with the host app, so no App
/// Group / entitlement is needed). Codepoints are stored as `[Int]`.
final class RecentsStore {

    static let shared = RecentsStore()

    private let defaults = UserDefaults.standard
    private let recentsKey = "unicodeKeyboard.recents"
    private let favoritesKey = "unicodeKeyboard.favorites"
    private let recentsCap = 60

    private init() {}

    // MARK: - Recents (most-recent-first)

    var recents: [UInt32] {
        (defaults.array(forKey: recentsKey) as? [Int])?.map { UInt32(truncatingIfNeeded: $0) } ?? []
    }

    func addRecent(_ cp: UInt32) {
        var arr = (defaults.array(forKey: recentsKey) as? [Int]) ?? []
        let value = Int(cp)
        arr.removeAll { $0 == value }
        arr.insert(value, at: 0)
        if arr.count > recentsCap { arr = Array(arr.prefix(recentsCap)) }
        defaults.set(arr, forKey: recentsKey)
    }

    // MARK: - Favorites

    var favorites: [UInt32] {
        (defaults.array(forKey: favoritesKey) as? [Int])?.map { UInt32(truncatingIfNeeded: $0) } ?? []
    }

    func isFavorite(_ cp: UInt32) -> Bool {
        ((defaults.array(forKey: favoritesKey) as? [Int]) ?? []).contains(Int(cp))
    }

    /// Returns the new favorite state for `cp`.
    @discardableResult
    func toggleFavorite(_ cp: UInt32) -> Bool {
        var arr = (defaults.array(forKey: favoritesKey) as? [Int]) ?? []
        let value = Int(cp)
        if let i = arr.firstIndex(of: value) {
            arr.remove(at: i)
            defaults.set(arr, forKey: favoritesKey)
            return false
        } else {
            arr.insert(value, at: 0)
            defaults.set(arr, forKey: favoritesKey)
            return true
        }
    }
}
