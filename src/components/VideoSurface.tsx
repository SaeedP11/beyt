import { useEffect, useRef } from "react";

import { engine } from "../backend/engine";

/** The picture in the browser build, where there is no mpv window under the page.
 *  Clicks pass through to the app, which handles them like it does on the desktop. */
export function VideoSurface({ visible }: { visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.appendChild(engine.video);
    return () => void engine.video.remove();
  }, []);
  return (
    <div
      ref={host}
      aria-hidden
      className="pointer-events-none absolute inset-0 bg-black"
      style={{ display: visible ? "block" : "none" }}
    />
  );
}
