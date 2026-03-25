import { useState, useEffect } from "react";
import SmelterStats from "./tools/SmelterStats.tsx";
import WhipStreamer from "./tools/WhipStreamer.tsx";
import WhepPlayer from "./tools/WhepPlayer.tsx";

const TOOLS = [
  { id: "smelter-stats", name: "Smelter Stats", description: "Real-time statistics dashboard" },
  {
    id: "whip-streamer",
    name: "WHIP Streamer",
    description: "Stream screen or camera via WebRTC WHIP",
  },
  {
    id: "whep-player",
    name: "WHEP Player",
    description: "Receive and play a stream via WebRTC WHEP",
  },
] as const;

type ToolId = (typeof TOOLS)[number]["id"];

interface HashRoute {
  path: string;
  params: URLSearchParams;
}

function parseHash(hash: string): HashRoute {
  const raw = hash.slice(1); // remove #
  const qIndex = raw.indexOf("?");
  if (qIndex === -1) return { path: raw, params: new URLSearchParams() };
  return { path: raw.slice(0, qIndex), params: new URLSearchParams(raw.slice(qIndex + 1)) };
}

function useHashRoute(): HashRoute {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return route;
}

function ToolPage({ id, params }: { id: ToolId; params: URLSearchParams }) {
  switch (id) {
    case "smelter-stats":
      return <SmelterStats params={params} />;
    case "whip-streamer":
      return <WhipStreamer params={params} />;
    case "whep-player":
      return <WhepPlayer params={params} />;
  }
}

export default function App() {
  const { path, params } = useHashRoute();
  const activeTool = TOOLS.find((t) => t.id === path);

  if (activeTool) {
    return (
      <div style={{ margin: "2rem", fontFamily: "system-ui" }}>
        <a
          href="#"
          style={{ textDecoration: "none", color: "var(--text-muted)", fontSize: "0.9rem" }}
        >
          &larr; Back to tools
        </a>
        <h1 style={{ marginTop: "0.5rem" }}>{activeTool.name}</h1>
        <ToolPage id={activeTool.id} params={params} />
      </div>
    );
  }

  return (
    <div style={{ margin: "2rem", fontFamily: "system-ui" }}>
      <h1>Smelter Tools</h1>
      <div
        style={{
          display: "grid",
          gap: "1rem",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
        }}
      >
        {TOOLS.map((tool) => (
          <a
            key={tool.id}
            href={`#${tool.id}`}
            style={{
              display: "block",
              padding: "1.5rem",
              border: "1px solid var(--border)",
              borderRadius: 8,
              textDecoration: "none",
              color: "inherit",
              transition: "box-shadow 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "0 2px 12px var(--shadow)")}
            onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "none")}
          >
            <h2 style={{ margin: "0 0 0.5rem" }}>{tool.name}</h2>
            <p style={{ margin: 0, color: "var(--text-muted)" }}>{tool.description}</p>
          </a>
        ))}
      </div>
    </div>
  );
}
