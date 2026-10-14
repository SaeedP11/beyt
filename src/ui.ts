// Helpers shared by the React screens and the plain-TypeScript player.

export function fmtTime(t: number): string {
  const sign = t < 0 ? "-" : "";
  t = Math.abs(t);
  const hours = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(t % 60)).padStart(2, "0");
  return `${sign}${hours ? `${hours}:` : ""}${mm}:${ss}`;
}

/** A button on a toast, such as Undo. */
export interface ToastAction {
  label: string;
  run: () => void;
}

type ToastFn = (msg: string, ms: number, action?: ToastAction) => void;
let showToast: ToastFn = (msg) => console.info(msg);

/** Lets the React app route toasts to its PrimeReact `<Toast>`. */
export function setToastHandler(fn: ToastFn): void {
  showToast = fn;
}

export function toast(msg: string, ms = 1800, action?: ToastAction): void {
  showToast(msg, ms, action);
}

/** Calls `fn` once things have been quiet for `ms`. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: number | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  };
}
