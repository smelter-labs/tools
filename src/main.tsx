import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";

// React's dev build logs a performance.measure() user-timing entry, carrying a
// serialized props diff, for nearly every component render (the DevTools
// "Component Performance Tracks" feature). The user-timing buffer is never
// evicted, so pages that re-render continuously (like the stats dashboard)
// leak native memory until the tab crashes. Dropping the entries periodically
// keeps long dev sessions alive; recorded Performance-panel traces are
// unaffected, since they capture measures at emit time.
if (import.meta.env.DEV) {
  setInterval(() => {
    performance.clearMeasures();
    performance.clearMarks();
  }, 10_000);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
