import { keyParts } from "../keymap";

/** Keyboard keys drawn as keycaps; several bindings are separated by "or". */
export function KeyCaps({ bindings, empty }: { bindings: readonly string[]; empty?: string }) {
  if (!bindings.length) return <span className="text-xs text-zinc-500">{empty}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" dir="ltr">
      {bindings.map((binding, i) => (
        <span key={binding} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-xs text-zinc-500">/</span>}
          {keyParts(binding).map((part, j) => (
            <kbd
              key={j}
              className="min-w-6 rounded-md border border-ink-600 border-b-2 bg-ink-800 px-1.5 py-0.5 text-center font-sans text-xs font-semibold text-zinc-200"
            >
              {part}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}
