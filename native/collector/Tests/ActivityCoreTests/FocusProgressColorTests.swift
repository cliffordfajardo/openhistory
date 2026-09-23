import Testing
@testable import ActivityCore

@Test func sixHexDigitsBecomeTheirComponents() {
    let color = FocusProgressColor.parse("#5c9e73")
    #expect(color == FocusProgressColor.fallback, "the default green is written the same way")
    #expect(color?.red == Double(0x5c) / 255)
    #expect(color?.green == Double(0x9e) / 255)
    #expect(color?.blue == Double(0x73) / 255)
    #expect(FocusProgressColor.parse("#000000")?.red == 0)
    #expect(FocusProgressColor.parse("#ffffff")?.blue == 1)
}

@Test func uppercaseAndLowercaseHexReadTheSame() {
    #expect(FocusProgressColor.parse("#5C9E73") == FocusProgressColor.parse("#5c9e73"))
    #expect(FocusProgressColor.parse("#AbCdEf") == FocusProgressColor.parse("#abcdef"))
}

@Test func anythingOtherThanSixAsciiHexDigitsIsRefused() {
    for value in [
        "", "#", "#5c9e7", "#5c9e733", "5c9e73", " #5c9e73", "#5c9e73 ",
        "#5c9e7g", "#5c9e7z", "##5c9e7", "#5c 9e73", "rebeccapurple", "rgb(1,2,3)"
    ] {
        #expect(FocusProgressColor.parse(value) == nil, "\(value) is not a color")
    }
}

@Test func signsAndNonAsciiDigitsAreNotHexDigits() {
    for value in ["#+5c9e7", "#-5c9e7", "#5c9e7+", "＃5c9e73", "#５c9e73", "#५c9e73", "#5c9e7\u{0660}"] {
        #expect(FocusProgressColor.parse(value) == nil, "\(value) is not a color")
    }
}

@Test func aMissingOrMalformedColorFallsBackToTheOriginalGreen() {
    #expect(FocusProgressColor.parseOrFallback(nil) == FocusProgressColor.fallback)
    #expect(FocusProgressColor.parseOrFallback("#nope!!") == FocusProgressColor.fallback)
    #expect(FocusProgressColor.parseOrFallback("#b86b5c") != FocusProgressColor.fallback)
}

@Test func theAlphaIsThePerSurfaceChoiceAndTheHueIsNot() {
    let color = FocusProgressColor.parse("#b86b5c")!
    let components = color.cgColor(alpha: 0.24).components
    #expect(components?.count == 4)
    #expect(abs((components?[0] ?? -1) - Double(0xb8) / 255) < 0.000001)
    #expect(components?[3] == 0.24)
    #expect(color.cgColor(alpha: 0.14).components?[3] == 0.14)
}
