import UIKit

/// System-wide custom keyboard for browsing and inserting Unicode characters,
/// modeled on the unicode-explorer web app: browse by block -> subgroup ->
/// character, free-text name search, plus Recents and Favorites.
///
/// Rendering uses system fonts (iOS has broad Unicode + emoji coverage), so no
/// font files are bundled. Inserting a glyph uses `textDocumentProxy` and needs
/// no "Full Access".
final class KeyboardViewController: UIInputViewController {

    // MARK: - Model

    private enum Category: Equatable {
        case favorites
        case recents
        case block(Int)
    }

    private enum Mode { case browse, search }

    private enum CellItem {
        case indexed(Int)   // global browse index into UnicodeStore
        case raw(UInt32)    // bare codepoint (recents/favorites)
    }

    private let store = UnicodeStore.shared
    private let recents = RecentsStore.shared

    private var mode: Mode = .browse
    private var category: Category = .recents
    private var query = ""
    private var sections: [(title: String?, items: [CellItem])] = []
    private var categories: [Category] = []

    // MARK: - Views

    private var heightConstraint: NSLayoutConstraint!
    private var nextKeyboardButton: UIButton!
    private let searchLabel = UILabel()
    private var categoryBar: UICollectionView!
    private var grid: UICollectionView!
    private let searchKeyboard = SearchKeyboardView()

    private let browseHeight: CGFloat = 268
    private let searchHeight: CGFloat = 322

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.systemBackground

        heightConstraint = view.heightAnchor.constraint(equalToConstant: browseHeight)
        heightConstraint.priority = .init(999)   // avoid conflict during initial layout
        heightConstraint.isActive = true

        guard store != nil else {
            showFatal("Unicode data failed to load.")
            return
        }

        buildCategories()
        buildUI()
        rebuildSections()
        grid.reloadData()
        categoryBar.reloadData()
    }

    private func showFatal(_ message: String) {
        let label = UILabel()
        label.text = message
        label.textColor = .secondaryLabel
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 16),
        ])
    }

    private func buildCategories() {
        guard let store = store else { return }
        categories = [.favorites, .recents] + (0 ..< store.blocks.count).map { .block($0) }
        // Default to a more interesting block than Basic Latin if Recents is empty.
        if recents.recents.isEmpty {
            if let arrows = store.blocks.firstIndex(where: { $0.name.contains("Arrows") }) {
                category = .block(arrows)
            } else if !store.blocks.isEmpty {
                category = .block(0)
            }
        } else {
            category = .recents
        }
    }

    // MARK: - UI construction

    private func buildUI() {
        let column = UIStackView()
        column.axis = .vertical
        column.spacing = 0
        column.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            column.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            column.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        column.addArrangedSubview(makeUtilityBar())
        column.addArrangedSubview(makeSearchBar())
        column.addArrangedSubview(makeCategoryBar())
        column.addArrangedSubview(makeGrid())

        searchKeyboard.delegate = self
        searchKeyboard.isHidden = true
        searchKeyboard.heightAnchor.constraint(equalToConstant: 176).isActive = true
        column.addArrangedSubview(searchKeyboard)
    }

    private func makeUtilityBar() -> UIView {
        let bar = UIStackView()
        bar.axis = .horizontal
        bar.spacing = 6
        bar.alignment = .fill
        bar.isLayoutMarginsRelativeArrangement = true
        bar.layoutMargins = .init(top: 4, left: 6, bottom: 4, right: 6)
        bar.heightAnchor.constraint(equalToConstant: 42).isActive = true

        nextKeyboardButton = makeUtilityButton("🌐", #selector(handleNextKeyboard))
        let space = makeUtilityButton("space", #selector(handleSpace))
        space.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let back = makeUtilityButton("⌫", #selector(handleBackspace))
        let ret = makeUtilityButton("return", #selector(handleReturn))
        back.widthAnchor.constraint(equalToConstant: 52).isActive = true

        bar.addArrangedSubview(nextKeyboardButton)
        bar.addArrangedSubview(space)
        bar.addArrangedSubview(back)
        bar.addArrangedSubview(ret)
        nextKeyboardButton.isHidden = !needsInputModeSwitchKey
        return bar
    }

    private func makeUtilityButton(_ title: String, _ action: Selector) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(title, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 16)
        b.setTitleColor(.label, for: .normal)
        b.backgroundColor = UIColor.secondarySystemBackground
        b.layer.cornerRadius = 6
        b.contentEdgeInsets = .init(top: 0, left: 10, bottom: 0, right: 10)
        b.addTarget(self, action: action, for: .touchUpInside)
        return b
    }

    private func makeSearchBar() -> UIView {
        let container = UIView()
        container.heightAnchor.constraint(equalToConstant: 38).isActive = true

        let field = UIView()
        field.backgroundColor = UIColor.secondarySystemBackground
        field.layer.cornerRadius = 8
        field.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(field)

        searchLabel.text = "🔍  Search by name"
        searchLabel.font = .systemFont(ofSize: 14)
        searchLabel.textColor = .secondaryLabel
        searchLabel.translatesAutoresizingMaskIntoConstraints = false
        field.addSubview(searchLabel)

        let clear = UIButton(type: .system)
        clear.setTitle("✕", for: .normal)
        clear.titleLabel?.font = .systemFont(ofSize: 15)
        clear.setTitleColor(.secondaryLabel, for: .normal)
        clear.translatesAutoresizingMaskIntoConstraints = false
        clear.addTarget(self, action: #selector(clearSearch), for: .touchUpInside)
        field.addSubview(clear)

        NSLayoutConstraint.activate([
            field.topAnchor.constraint(equalTo: container.topAnchor, constant: 2),
            field.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -4),
            field.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 6),
            field.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -6),
            searchLabel.leadingAnchor.constraint(equalTo: field.leadingAnchor, constant: 10),
            searchLabel.centerYAnchor.constraint(equalTo: field.centerYAnchor),
            clear.trailingAnchor.constraint(equalTo: field.trailingAnchor, constant: -8),
            clear.centerYAnchor.constraint(equalTo: field.centerYAnchor),
        ])

        let tap = UITapGestureRecognizer(target: self, action: #selector(enterSearch))
        field.addGestureRecognizer(tap)
        return container
    }

    private func makeCategoryBar() -> UIView {
        let layout = UICollectionViewFlowLayout()
        layout.scrollDirection = .horizontal
        layout.estimatedItemSize = UICollectionViewFlowLayout.automaticSize
        layout.minimumLineSpacing = 6
        layout.sectionInset = .init(top: 4, left: 8, bottom: 4, right: 8)

        categoryBar = UICollectionView(frame: .zero, collectionViewLayout: layout)
        categoryBar.backgroundColor = .clear
        categoryBar.showsHorizontalScrollIndicator = false
        categoryBar.dataSource = self
        categoryBar.delegate = self
        categoryBar.register(ChipCell.self, forCellWithReuseIdentifier: ChipCell.reuseID)
        categoryBar.heightAnchor.constraint(equalToConstant: 38).isActive = true
        return categoryBar
    }

    private func makeGrid() -> UIView {
        grid = UICollectionView(frame: .zero, collectionViewLayout: makeGridLayout())
        grid.backgroundColor = .clear
        grid.alwaysBounceVertical = true
        grid.dataSource = self
        grid.delegate = self
        grid.register(GlyphCell.self, forCellWithReuseIdentifier: GlyphCell.reuseID)
        grid.register(HeaderView.self,
                      forSupplementaryViewOfKind: UICollectionView.elementKindSectionHeader,
                      withReuseIdentifier: HeaderView.reuseID)
        grid.setContentHuggingPriority(.defaultLow, for: .vertical)
        grid.setContentCompressionResistancePriority(.defaultLow, for: .vertical)

        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
        longPress.minimumPressDuration = 0.35
        grid.addGestureRecognizer(longPress)
        return grid
    }

    private func makeGridLayout() -> UICollectionViewLayout {
        UICollectionViewCompositionalLayout { [weak self] sectionIndex, env in
            let columns = max(1, Int(env.container.effectiveContentSize.width / 48))
            let item = NSCollectionLayoutItem(layoutSize: .init(
                widthDimension: .fractionalWidth(1.0 / CGFloat(columns)),
                heightDimension: .fractionalHeight(1.0)))
            item.contentInsets = .init(top: 2, leading: 2, bottom: 2, trailing: 2)
            let group = NSCollectionLayoutGroup.horizontal(
                layoutSize: .init(widthDimension: .fractionalWidth(1.0), heightDimension: .absolute(46)),
                subitem: item, count: columns)
            let section = NSCollectionLayoutSection(group: group)
            section.contentInsets = .init(top: 2, leading: 4, bottom: 2, trailing: 4)

            if let title = self?.sections[safe: sectionIndex]?.title, !title.isEmpty {
                let header = NSCollectionLayoutBoundarySupplementaryItem(
                    layoutSize: .init(widthDimension: .fractionalWidth(1.0), heightDimension: .absolute(20)),
                    elementKind: UICollectionView.elementKindSectionHeader, alignment: .top)
                section.boundarySupplementaryItems = [header]
            }
            return section
        }
    }

    // MARK: - Sections

    private func rebuildSections() {
        guard let store = store else { sections = []; return }
        switch mode {
        case .search:
            let results = store.search(query)
            let title = query.isEmpty ? "Type to search" : "Results: \(results.count)"
            sections = [(title, results.map { CellItem.indexed($0) })]
        case .browse:
            switch category {
            case .favorites:
                let items = recents.favorites.map { CellItem.raw($0) }
                sections = [(items.isEmpty ? "No favorites yet — long-press a glyph" : "Favorites", items)]
            case .recents:
                let items = recents.recents.map { CellItem.raw($0) }
                sections = [(items.isEmpty ? "No recents yet" : "Recents", items)]
            case .block(let bi):
                let block = store.blocks[bi]
                sections = block.subgroups.map { sg in
                    (sg.name, (sg.first ..< (sg.first + sg.count)).map { CellItem.indexed($0) })
                }
            }
        }
    }

    // MARK: - Helpers

    private func codepoint(_ item: CellItem) -> UInt32 {
        switch item {
        case .indexed(let i): return store?.codepoint(i) ?? 0
        case .raw(let cp): return cp
        }
    }
    private func glyph(_ item: CellItem) -> String {
        store?.string(forCodepoint: codepoint(item)) ?? ""
    }

    private func insert(_ item: CellItem) {
        let cp = codepoint(item)
        guard let s = store?.string(forCodepoint: cp) else { return }
        textDocumentProxy.insertText(s)
        recents.addRecent(cp)
    }

    // MARK: - Mode / search

    @objc private func enterSearch() {
        guard mode != .search else { return }
        mode = .search
        categoryBar.isHidden = true
        searchKeyboard.isHidden = false
        heightConstraint.constant = searchHeight
        rebuildSections()
        grid.reloadData()
        updateSearchLabel()
    }

    private func exitSearch() {
        mode = .browse
        searchKeyboard.isHidden = true
        categoryBar.isHidden = false
        heightConstraint.constant = browseHeight
        rebuildSections()
        grid.reloadData()
        updateSearchLabel()
    }

    @objc private func clearSearch() {
        if mode == .search {
            query = ""
            rebuildSections()
            grid.reloadData()
            updateSearchLabel()
        }
    }

    private func updateSearchLabel() {
        if mode == .search {
            searchLabel.text = query.isEmpty ? "🔍  Type to search…" : "🔍  \(query)"
            searchLabel.textColor = query.isEmpty ? .secondaryLabel : .label
        } else {
            searchLabel.text = "🔍  Search by name"
            searchLabel.textColor = .secondaryLabel
        }
    }

    // MARK: - Utility actions

    @objc private func handleNextKeyboard() { advanceToNextInputMode() }
    @objc private func handleBackspace() { textDocumentProxy.deleteBackward() }
    @objc private func handleSpace() { textDocumentProxy.insertText(" ") }
    @objc private func handleReturn() { textDocumentProxy.insertText("\n") }

    @objc private func handleLongPress(_ g: UILongPressGestureRecognizer) {
        guard g.state == .began else { return }
        let point = g.location(in: grid)
        guard let ip = grid.indexPathForItem(at: point),
              let item = sections[safe: ip.section]?.items[safe: ip.item] else { return }
        recents.toggleFavorite(codepoint(item))
        grid.reloadItems(at: [ip])
    }
}

// MARK: - Collection data source / delegate

extension KeyboardViewController: UICollectionViewDataSource, UICollectionViewDelegate {

    func numberOfSections(in collectionView: UICollectionView) -> Int {
        collectionView === categoryBar ? 1 : sections.count
    }

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        if collectionView === categoryBar { return categories.count }
        return sections[safe: section]?.items.count ?? 0
    }

    func collectionView(_ collectionView: UICollectionView,
                        cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        if collectionView === categoryBar {
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: ChipCell.reuseID, for: indexPath) as! ChipCell
            cell.configure(title(for: categories[indexPath.item]), selected: categories[indexPath.item] == category && mode == .browse)
            return cell
        }
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: GlyphCell.reuseID, for: indexPath) as! GlyphCell
        if let item = sections[safe: indexPath.section]?.items[safe: indexPath.item] {
            cell.configure(glyph: glyph(item), favorite: recents.isFavorite(codepoint(item)))
        }
        return cell
    }

    func collectionView(_ collectionView: UICollectionView,
                        viewForSupplementaryElementOfKind kind: String,
                        at indexPath: IndexPath) -> UICollectionReusableView {
        let header = collectionView.dequeueReusableSupplementaryView(
            ofKind: kind, withReuseIdentifier: HeaderView.reuseID, for: indexPath) as! HeaderView
        header.label.text = sections[safe: indexPath.section]?.title
        return header
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        if collectionView === categoryBar {
            category = categories[indexPath.item]
            if mode == .search { exitSearch() }
            rebuildSections()
            grid.reloadData()
            categoryBar.reloadData()
            if !sections.isEmpty {
                grid.scrollToItem(at: IndexPath(item: 0, section: 0), at: .top, animated: false)
            }
            return
        }
        if let item = sections[safe: indexPath.section]?.items[safe: indexPath.item] {
            insert(item)
        }
    }

    private func title(for category: Category) -> String {
        switch category {
        case .favorites: return "★ Favorites"
        case .recents: return "🕘 Recents"
        case .block(let i): return store?.blocks[i].name ?? "—"
        }
    }
}

// MARK: - Search keyboard delegate

extension KeyboardViewController: SearchKeyboardDelegate {
    func searchKeyboard(_ view: SearchKeyboardView, didInsert text: String) {
        query += text
        rebuildSections()
        grid.reloadData()
        updateSearchLabel()
    }
    func searchKeyboardDidBackspace(_ view: SearchKeyboardView) {
        guard !query.isEmpty else { return }
        query.removeLast()
        rebuildSections()
        grid.reloadData()
        updateSearchLabel()
    }
    func searchKeyboardDidClose(_ view: SearchKeyboardView) {
        exitSearch()
    }
}

// MARK: - Cells

final class GlyphCell: UICollectionViewCell {
    static let reuseID = "glyph"
    private let label = UILabel()
    private let star = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = UIColor.secondarySystemBackground
        contentView.layer.cornerRadius = 6

        label.textAlignment = .center
        label.adjustsFontSizeToFitWidth = true
        label.minimumScaleFactor = 0.4
        label.font = .systemFont(ofSize: 24)
        label.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(label)

        star.text = "★"
        star.font = .systemFont(ofSize: 9)
        star.textColor = .systemYellow
        star.isHidden = true
        star.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(star)

        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            label.widthAnchor.constraint(lessThanOrEqualTo: contentView.widthAnchor, constant: -4),
            star.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 2),
            star.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -3),
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(glyph: String, favorite: Bool) {
        label.text = glyph
        star.isHidden = !favorite
    }
    override var isHighlighted: Bool {
        didSet { contentView.alpha = isHighlighted ? 0.5 : 1.0 }
    }
}

final class HeaderView: UICollectionReusableView {
    static let reuseID = "header"
    let label = UILabel()
    override init(frame: CGRect) {
        super.init(frame: frame)
        label.font = .systemFont(ofSize: 11, weight: .semibold)
        label.textColor = .secondaryLabel
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8),
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

final class ChipCell: UICollectionViewCell {
    static let reuseID = "chip"
    private let label = UILabel()
    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.layer.cornerRadius = 14
        label.font = .systemFont(ofSize: 13)
        label.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 11),
            label.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -11),
            label.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 4),
            label.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -4),
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func configure(_ title: String, selected: Bool) {
        label.text = title
        contentView.backgroundColor = selected ? .systemBlue : UIColor.secondarySystemBackground
        label.textColor = selected ? .white : .label
    }
}

// MARK: - Safe indexing

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
