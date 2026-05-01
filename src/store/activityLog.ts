import { create } from "zustand";

export type LogLevel = "info" | "ok" | "warn" | "err";
export type LogChannel = "API" | "TX" | "EVT" | "CHAIN" | "QUOTE" | "SES";

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  channel: LogChannel;
  message: string;
  details?: string;
}

interface ActivityLogState {
  entries: LogEntry[];
  push: (entry: Omit<LogEntry, "id" | "ts"> & { ts?: number }) => void;
  clear: () => void;
}

let nextId = 1;
const MAX_ENTRIES = 200;

export const useActivityLog = create<ActivityLogState>((set) => ({
  entries: [],
  push: (entry) =>
    set((s) => {
      const next: LogEntry = {
        id: nextId++,
        ts: entry.ts ?? Date.now(),
        level: entry.level,
        channel: entry.channel,
        message: entry.message,
        details: entry.details,
      };
      const merged = [next, ...s.entries];
      return { entries: merged.slice(0, MAX_ENTRIES) };
    }),
  clear: () => set({ entries: [] }),
}));

export function logTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
