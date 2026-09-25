import { app } from "electron";
import { config as loadDotEnv } from "dotenv";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InferenceProvider } from "@shared/inference";

export const APP_IDENTITY = {
  productName: "OpenHistory Focus",
  bundleIdentifier: "io.github.cliffordfajardo.openhistory-focus",
  userDataDirectoryName: "OpenHistory Focus"
} as const;

export const DEFAULT_MCP_PORT = 47_841;

export interface RuntimeConfig {
  dataDirectory: string;
  adoptExistingDataDirectory: boolean;
  inferenceApiKeys: Record<InferenceProvider, string | undefined>;
  inferenceModels: Record<InferenceProvider, string>;
  mcpPort: number;
}

/**
 * Must run before app.requestSingleInstanceLock(): the lock, cookies, caches and the default
 * activity-data root all derive from userData, which must not be upstream's directory.
 */
export function configureAppIdentity(): void {
  app.setName(APP_IDENTITY.productName);
  app.setPath("userData", join(app.getPath("appData"), APP_IDENTITY.userDataDirectoryName));
}

function loadLocalEnvironment(): void {
  const candidates = [
    resolve(process.cwd(), ".env.local"),
    resolve(app.getAppPath(), ".env.local")
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      loadDotEnv({ path, override: false });
      return;
    }
  }
}

export function getRuntimeConfig(): RuntimeConfig {
  loadLocalEnvironment();
  const customDataDirectory = process.env.OPENHISTORY_FOCUS_DATA_DIR?.trim();
  const defaultDataDirectory = resolve(app.getPath("userData"), "activity-data");

  return {
    dataDirectory: customDataDirectory || defaultDataDirectory,
    adoptExistingDataDirectory: customDataDirectory
      ? process.env.OPENHISTORY_FOCUS_ADOPT_DATA_DIR?.trim() === "1"
      : true,
    inferenceApiKeys: {
      apple: undefined,
      openai: process.env.OPENAI_API_KEY?.trim() || undefined,
      anthropic: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
      kimi: process.env.MOONSHOT_API_KEY?.trim() || undefined
    },
    inferenceModels: {
      apple: "system-default",
      openai: process.env.OPENAI_MODEL?.trim() || "gpt-5.6-luna",
      anthropic: process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5",
      kimi: process.env.MOONSHOT_MODEL?.trim() || "kimi-k3"
    },
    mcpPort: localPort(process.env.OPENHISTORY_FOCUS_MCP_PORT)
  };
}

export function localPort(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_MCP_PORT;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1_024 && parsed <= 65_535 ? parsed : DEFAULT_MCP_PORT;
}
