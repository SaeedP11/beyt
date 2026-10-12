import { Button } from "primereact/button";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { api } from "../api";
import { getLang, t } from "../i18n";

/** Sends an error to Beyt's log file (the webview's console is lost on close). */
export function logError(error: unknown, context = ""): void {
  const text = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  void api.logError(context ? `${context}: ${text}` : text).catch(() => {});
}

/**
 * Catches an error while drawing the interface. Without it React removes the
 * whole page, leaving a frozen window that ignores every key and click.
 */
export class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logError(error, `render${info.componentStack ?? ""}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // The page reloads and Rust's `initial_file` reopens the video that was playing.
    return (
      <div
        dir={getLang() === "fa" ? "rtl" : "ltr"}
        className="fixed inset-0 z-[9999] grid place-items-center bg-ink-950/85 p-4 text-zinc-100"
      >
        <div role="alert" className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border border-ink-700 bg-ink-900 p-6 text-center shadow-2xl">
          <i className="pi pi-exclamation-triangle text-3xl text-amber-400" />
          <h1 className="text-lg font-semibold">{t("crashTitle")}</h1>
          <p className="text-sm text-zinc-400">{t("crashHint")}</p>
          <p className="max-h-24 w-full overflow-y-auto break-words rounded-lg bg-ink-950 px-3 py-2 text-start font-mono text-xs text-zinc-500" dir="ltr">
            {error.message || String(error)}
          </p>
          <Button label={t("reload")} icon="pi pi-refresh" autoFocus onClick={() => location.reload()} />
        </div>
      </div>
    );
  }
}
