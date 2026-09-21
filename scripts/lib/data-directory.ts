import { homedir } from "node:os";
import { resolve } from "node:path";

export function defaultOpenHistoryDataDirectory(): string {
  const configured = process.env.OPENHISTORY_FOCUS_DATA_DIR?.trim();
  if (configured) return configured;
  return resolve(homedir(), "Library", "Application Support", "OpenHistory Focus", "activity-data");
}
