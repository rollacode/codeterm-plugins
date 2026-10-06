import { readDataFile, writeDataFile } from "./datafiles";

const SESSIONS_FILE = "sessions.json";

export interface SavedSession {
  model: string;
  preset?: string;
}

function readAll(): Record<string, SavedSession> {
  try {
    const data = JSON.parse(readDataFile(SESSIONS_FILE) || "{}") as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, SavedSession>) : {};
  } catch {
    return {};
  }
}

export function savedSession(sid: string): SavedSession | null {
  const entry = readAll()[sid];
  return entry && typeof entry.model === "string" ? entry : null;
}

export function saveSession(sid: string, entry: SavedSession): void {
  const all = readAll();
  all[sid] = entry;
  writeDataFile(SESSIONS_FILE, JSON.stringify(all));
}

export function forgetSession(sid: string): void {
  const all = readAll();
  if (!(sid in all)) return;
  delete all[sid];
  writeDataFile(SESSIONS_FILE, JSON.stringify(all));
}
