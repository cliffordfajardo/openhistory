public enum BrowserProtectionObservation: Equatable, Sendable {
    case unavailable
    case protected
    case safe
}

public enum BrowserProtectionTransition: Equatable, Sendable {
    case none
    case enter
    case leave
}

public struct BrowserProtectionStates: Equatable, Sendable {
    public let recording: BrowserProtectionObservation
    public let focus: BrowserProtectionObservation
}

public struct BrowserProtectionDecision: Sendable {
    public let suppressCapture: Bool
    public let transition: BrowserProtectionTransition

    public init(suppressCapture: Bool, transition: BrowserProtectionTransition) {
        self.suppressCapture = suppressCapture
        self.transition = transition
    }
}

public extension SemanticProtectionPolicy {
    static func browserProtectionStates(
        observation: BrowserObservation?,
        windowTitle: String?,
        captureEmailActivity: Bool,
        captureMessagingActivity: Bool
    ) -> BrowserProtectionStates {
        if protectsPrivateBrowsingWindow(title: windowTitle) {
            return BrowserProtectionStates(recording: .protected, focus: .protected)
        }
        guard let observation else {
            return BrowserProtectionStates(recording: .unavailable, focus: .unavailable)
        }
        return BrowserProtectionStates(
            recording: protectsBrowserObservation(
                observation,
                captureEmailActivity: captureEmailActivity,
                captureMessagingActivity: captureMessagingActivity
            ) ? .protected : .safe,
            focus: protectsFocusBrowserObservation(
                observation,
                captureMessagingActivity: captureMessagingActivity
            ) ? .protected : .safe
        )
    }

    static func browserProtectionDecision(
        for observation: BrowserProtectionObservation,
        wasProtected: Bool
    ) -> BrowserProtectionDecision {
        switch observation {
        case .unavailable:
            // Accessibility briefly loses the address while an ordinary page navigates.
            // Stay fail-closed for capture, but do not turn that transient state into a
            // privacy boundary that fragments the work timeline.
            return BrowserProtectionDecision(suppressCapture: true, transition: .none)
        case .protected:
            return BrowserProtectionDecision(
                suppressCapture: true,
                transition: wasProtected ? .none : .enter
            )
        case .safe:
            return BrowserProtectionDecision(
                suppressCapture: false,
                transition: wasProtected ? .leave : .none
            )
        }
    }
}
