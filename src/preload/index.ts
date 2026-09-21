import {
  IPC_CHANNELS,
  type ActivityEvent,
  type AgentAccessState,
  type BootstrapState,
  type OpenHistoryBridge,
  type HourState,
  type DailyRollupState,
  type TimelineState
} from "@shared/contracts";
import type { FocusViewState } from "@shared/focus";
import { contextBridge, ipcRenderer } from "electron";

const bridge: OpenHistoryBridge = {
  getBootstrap: () => ipcRenderer.invoke(IPC_CHANNELS.getBootstrap),
  setCollectionEnabled: (enabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.setCollectionEnabled, enabled),
  updateCollectionSettings: (settings) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateCollectionSettings, settings),
  updateInferenceSettings: (settings) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateInferenceSettings, settings),
  setInferenceApiKey: (provider, apiKey) =>
    ipcRenderer.invoke(IPC_CHANNELS.setInferenceApiKey, provider, apiKey),
  clearInferenceApiKey: (provider) =>
    ipcRenderer.invoke(IPC_CHANNELS.clearInferenceApiKey, provider),
  acceptPrivacyNotice: () => ipcRenderer.invoke(IPC_CHANNELS.acceptPrivacyNotice),
  completeInferenceOnboarding: (selection) =>
    ipcRenderer.invoke(IPC_CHANNELS.completeInferenceOnboarding, selection),
  completeLocalOnlyOnboarding: (selection) =>
    ipcRenderer.invoke(IPC_CHANNELS.completeLocalOnlyOnboarding, selection),
  refreshAppleAvailability: () =>
    ipcRenderer.invoke(IPC_CHANNELS.refreshAppleAvailability),
  authorizeCloudInference: (provider) =>
    ipcRenderer.invoke(IPC_CHANNELS.authorizeCloudInference, provider),
  requestAccessibilityPermission: () => ipcRenderer.invoke(IPC_CHANNELS.requestAccessibility),
  refreshAccessibilityPermission: () => ipcRenderer.invoke(IPC_CHANNELS.refreshAccessibility),
  openAccessibilitySettings: () => ipcRenderer.invoke(IPC_CHANNELS.openAccessibilitySettings),
  revealDataDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.revealDataDirectory),
  deleteAllData: () => ipcRenderer.invoke(IPC_CHANNELS.deleteAllData),
  exportDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.exportDiagnostics),
  quitApp: () => ipcRenderer.invoke(IPC_CHANNELS.quitApp),
  buildHistory: () => ipcRenderer.invoke(IPC_CHANNELS.buildHistory),
  copyAgentSetup: () => ipcRenderer.invoke(IPC_CHANNELS.copyAgentSetup),
  revokeAgentConnection: (id) => ipcRenderer.invoke(IPC_CHANNELS.revokeAgentConnection, id),
  listInstalledApplications: () => ipcRenderer.invoke(IPC_CHANNELS.listInstalledApplications),
  getApplicationIcon: (application) => ipcRenderer.invoke(IPC_CHANNELS.getApplicationIcon, application),
  historyChat: (turns) => ipcRenderer.invoke(IPC_CHANNELS.historyChat, turns),
  onActivityEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, activityEvent: ActivityEvent): void => {
      listener(activityEvent);
    };
    ipcRenderer.on(IPC_CHANNELS.activityEvent, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.activityEvent, handler);
  },
  onCollectorState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]): void => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.collectorState, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.collectorState, handler);
  },
  onTimelineState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: TimelineState): void => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.timelineState, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.timelineState, handler);
  },
  onHourState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: HourState): void => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.hourState, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.hourState, handler);
  },
  onDailyRollupState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DailyRollupState): void => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.dailyRollupState, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.dailyRollupState, handler);
  },
  onAgentAccessState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AgentAccessState): void => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.agentAccessState, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.agentAccessState, handler);
  },
  onBootstrapState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: BootstrapState): void => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.bootstrapState, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.bootstrapState, handler);
  },
  onOpenSettings: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on(IPC_CHANNELS.openSettings, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.openSettings, handler);
  },
  getFocusState: () => ipcRenderer.invoke(IPC_CHANNELS.getFocusState),
  saveGoal: (draft) => ipcRenderer.invoke(IPC_CHANNELS.saveGoal, draft),
  deleteGoal: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteGoal, id),
  selectGoal: (id) => ipcRenderer.invoke(IPC_CHANNELS.selectGoal, id),
  saveFocusPreferences: (preferences) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveFocusPreferences, preferences),
  startFocus: (request) => ipcRenderer.invoke(IPC_CHANNELS.startFocus, request),
  stopFocus: () => ipcRenderer.invoke(IPC_CHANNELS.stopFocus),
  snoozeFocus: () => ipcRenderer.invoke(IPC_CHANNELS.snoozeFocus),
  resumeFocus: () => ipcRenderer.invoke(IPC_CHANNELS.resumeFocus),
  previewFocusReminder: () => ipcRenderer.invoke(IPC_CHANNELS.previewFocusReminder),
  onFocusState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: FocusViewState): void => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.focusState, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.focusState, handler);
  },
  getActivityDay: (date) => ipcRenderer.invoke(IPC_CHANNELS.getActivityDay, date)
};

contextBridge.exposeInMainWorld("openHistory", bridge);
