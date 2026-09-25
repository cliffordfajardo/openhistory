import type { BootstrapState } from "@shared/contracts";

export interface DiagnosticEnvironment {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  osRelease: string;
}

export function sanitizedDiagnostics(
  state: BootstrapState,
  environment: DiagnosticEnvironment
): object {
  const focusSession = state.focus?.session;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    app: environment,
    collection: {
      enabled: state.collectionEnabled,
      state: state.collectorState,
      accessibilityTrusted: state.accessibilityTrusted,
      recentEventCount: state.recentEvents.length,
      privacyNoticeVersion: state.settings.privacyNoticeVersion,
      captureFeatures: {
        windowTitles: state.settings.captureWindowTitles,
        focusedElements: state.settings.captureFocusedElements,
        textInput: state.settings.captureTextInput,
        pointerClicks: state.settings.capturePointerClicks,
        browserURLs: state.settings.captureBrowserURLs,
        documentContext: state.settings.captureDocumentContext,
        uiSnapshots: state.settings.captureUISnapshots,
        emailActivity: state.settings.captureEmailActivity,
        messagingActivity: state.settings.captureMessagingActivity
      },
      excludedApplicationCount: state.settings.excludedBundleIdentifiers.length,
      capturePaused: state.settings.capturePaused === true
    },
    focus: {
      goalCount: state.focus?.goals.length ?? 0,
      distractingSiteCount: state.focus?.preferences.domains.length ?? 0,
      sessionActive: focusSession?.status === "active",
      sessionPaused: focusSession?.status === "active" && focusSession.endsAt === null,
      detection: state.focus?.detection ?? "unknown",
      reminderStyle: state.focus?.preferences.experience ?? "amber",
      sessionDisplay: state.focus?.preferences.barPresentation ?? "floating",
      /** Whether a place was saved for the bar, never where it is. */
      barPositionSaved: Boolean(state.focus?.barPosition),
      screenCaptureAccess: state.focus?.screenCapture?.access ?? "unsupported",
      lastEffect: state.focus?.effect
        ? { status: state.focus.effect.status, fallbackReason: state.focus.effect.fallbackReason }
        : null
    },
    inference: {
      enabled: state.inference.settings.enabled,
      provider: state.inference.settings.provider,
      model: state.inference.settings.models[state.inference.settings.provider],
      configured: state.inference.configured,
      keySource: state.inference.keySources[state.inference.settings.provider],
      hasTimelineError: Boolean(state.timeline.lastError),
      hasHourError: Boolean(state.hour.lastError),
      hasDayError: Boolean(state.dailyRollup.lastError)
    },
    localState: {
      timelineCount: state.timeline.items.length,
      pendingEpisodeCount: state.timeline.pendingEpisodeCount,
      hourCount: state.hour.items.length,
      pendingHourCount: state.hour.pendingHourCount,
      dailyRollupCount: state.dailyRollup.items.length,
      pendingDayCount: state.dailyRollup.pendingDayCount,
      agentConnectionCount: state.agentAccess.connections.length,
      agentServerStatus: state.agentAccess.status
    },
    privacy: {
      contentIncluded: false,
      pathsIncluded: false,
      credentialsIncluded: false
    }
  };
}
