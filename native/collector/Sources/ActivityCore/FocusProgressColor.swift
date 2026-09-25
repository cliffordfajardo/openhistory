import CoreGraphics

/**
 The one color both Focus progress fills are drawn in, as the app sends it: an opaque `#rrggbb`
 value. Each surface picks its own opacity, so only the hue travels across the bridge.

 Parsing is deliberately strict and tiny — no color names, no shorthand, no alpha and no sign — so
 the native side never invents a color the app did not ask for. Anything else is refused and the
 caller keeps drawing what it already had.
 */
public struct FocusProgressColor: Equatable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double

    /// The muted green both bars drew before the color could be chosen.
    public static let fallback = FocusProgressColor(red: 0x5c, green: 0x9e, blue: 0x73)

    private init(red: Int, green: Int, blue: Int) {
        self.red = Double(red) / 255
        self.green = Double(green) / 255
        self.blue = Double(blue) / 255
    }

    /// Six ASCII hex digits behind a `#`, nothing else. Returns nil for anything malformed.
    public static func parse(_ value: String) -> FocusProgressColor? {
        let scalars = Array(value.unicodeScalars)
        guard scalars.count == 7, scalars[0] == "#" else { return nil }
        var components: [Int] = []
        var index = 1
        while index < scalars.count {
            guard let high = digit(scalars[index]), let low = digit(scalars[index + 1]) else { return nil }
            components.append(high * 16 + low)
            index += 2
        }
        return FocusProgressColor(red: components[0], green: components[1], blue: components[2])
    }

    /// The parsed color, or the original green when the app sent nothing or sent nonsense.
    public static func parseOrFallback(_ value: String?) -> FocusProgressColor {
        value.flatMap(parse) ?? fallback
    }

    public func cgColor(alpha: Double) -> CGColor {
        CGColor(srgbRed: red, green: green, blue: blue, alpha: alpha)
    }

    private static func digit(_ scalar: Unicode.Scalar) -> Int? {
        switch scalar {
        case "0"..."9": return Int(scalar.value - 0x30)
        case "a"..."f": return Int(scalar.value - 0x61) + 10
        case "A"..."F": return Int(scalar.value - 0x41) + 10
        default: return nil
        }
    }
}
