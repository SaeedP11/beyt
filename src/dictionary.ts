// Whether the offline dictionary is installed, and installing it. Shared by
// the word popup and Settings so both show the same download.

import { useEffect, useSyncExternalStore } from "react";

import { api, events } from "./api";
import { t } from "./i18n";
import { toast } from "./ui";

export type DictionaryState =
  | { kind: "unknown" }
  | { kind: "missing" }
  /** `progress` is the fraction downloaded, or null when the size isn't known. */
  | { kind: "installing"; progress: number | null }
  | { kind: "ready"; entries: number }
  | { kind: "failed"; error: string };

let state: DictionaryState = { kind: "unknown" };
const listeners = new Set<() => void>();

function set(next: DictionaryState): void {
  state = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Asks the backend whether a dictionary is installed. */
export async function refreshDictionary(): Promise<void> {
  const { dictionaryEntries } = await api.dataInfo();
  if (state.kind === "installing") return;
  set(dictionaryEntries === null ? { kind: "missing" } : { kind: "ready", entries: dictionaryEntries });
}

/** A lookup found no dictionary. */
export function markDictionaryMissing(): void {
  if (state.kind !== "installing" && state.kind !== "failed") set({ kind: "missing" });
}

/** Downloads and builds the dictionary. Safe to call while one is running. */
export async function installDictionary(): Promise<void> {
  if (state.kind === "installing") return;
  set({ kind: "installing", progress: 0 });
  const unlisten = await events.dictionaryProgress((progress) => {
    if (state.kind === "installing") set({ kind: "installing", progress });
  });
  try {
    const entries = await api.installDictionary();
    set({ kind: "ready", entries });
    toast(t("dictionaryInstalled"));
  } catch (e) {
    set({ kind: "failed", error: String(e) });
  } finally {
    unlisten();
  }
}

/** The dictionary's state, checked with the backend on first use. */
export function useDictionary(): DictionaryState {
  const current = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (state.kind === "unknown") void refreshDictionary();
  }, []);
  return current;
}
