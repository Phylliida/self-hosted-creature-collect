import UIKit

protocol SearchKeyboardDelegate: AnyObject {
    func searchKeyboard(_ view: SearchKeyboardView, didInsert text: String)
    func searchKeyboardDidBackspace(_ view: SearchKeyboardView)
    func searchKeyboardDidClose(_ view: SearchKeyboardView)
}

/// A minimal built-in QWERTY used only for typing search queries. When our
/// custom keyboard is the active input method, focus inside our own UI does NOT
/// bring up another keyboard — so to let the user search by character name we
/// have to render our own letter keys.
final class SearchKeyboardView: UIView {

    weak var delegate: SearchKeyboardDelegate?

    private let rows = ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"]

    override init(frame: CGRect) {
        super.init(frame: frame)
        build()
    }
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        build()
    }

    private func build() {
        let column = UIStackView()
        column.axis = .vertical
        column.spacing = 5
        column.distribution = .fillEqually
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 3),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -3),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])

        for row in rows {
            let line = UIStackView()
            line.axis = .horizontal
            line.spacing = 4
            line.distribution = .fillEqually
            for ch in row {
                line.addArrangedSubview(makeKey(String(ch), action: #selector(letterTapped(_:))))
            }
            column.addArrangedSubview(line)
        }

        // Bottom row: backspace | space | done
        let bottom = UIStackView()
        bottom.axis = .horizontal
        bottom.spacing = 4
        bottom.distribution = .fill

        let back = makeKey("⌫", action: #selector(backspaceTapped))
        let space = makeKey("space", action: #selector(spaceTapped))
        let done = makeKey("Done", action: #selector(doneTapped))
        space.setContentHuggingPriority(.defaultLow, for: .horizontal)
        back.widthAnchor.constraint(equalToConstant: 56).isActive = true
        done.widthAnchor.constraint(equalToConstant: 64).isActive = true

        bottom.addArrangedSubview(back)
        bottom.addArrangedSubview(space)
        bottom.addArrangedSubview(done)
        column.addArrangedSubview(bottom)
    }

    private func makeKey(_ title: String, action: Selector) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: title.count == 1 ? 18 : 14)
        button.setTitleColor(.label, for: .normal)
        button.backgroundColor = UIColor.tertiarySystemBackground
        button.layer.cornerRadius = 5
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }

    @objc private func letterTapped(_ sender: UIButton) {
        if let t = sender.title(for: .normal) { delegate?.searchKeyboard(self, didInsert: t) }
    }
    @objc private func spaceTapped() { delegate?.searchKeyboard(self, didInsert: " ") }
    @objc private func backspaceTapped() { delegate?.searchKeyboardDidBackspace(self) }
    @objc private func doneTapped() { delegate?.searchKeyboardDidClose(self) }
}
