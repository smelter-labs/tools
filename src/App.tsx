import { useState, useEffect } from "react";
import SmelterStats from "./tools/SmelterStats.tsx";
import WhipStreamer from "./tools/WhipStreamer.tsx";

const TOOLS = [
  { id: "smelter-stats", name: "Smelter Stats", description: "Real-time statistics dashboard" },
  { id: "whip-streamer", name: "WHIP Streamer", description: "Stream screen or camera via WebRTC WHIP" },
] as const;

type ToolId = (typeof TOOLS)[number]["id"];

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash.slice(1));
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash.slice(1));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return hash;
}

function ToolPage({ id }: { id: ToolId }) {
  switch (id) {
    case "smelter-stats":
      return <SmelterStats />;
    case "whip-streamer":
      return <WhipStreamer />;
  }
}

export default function App() {
  const hash = useHash();
  const activeTool = TOOLS.find((t) => t.id === hash);

  if (activeTool) {
    return (
      <div style={{ maxWidth: 900, margin: "2rem auto", fontFamily: "system-ui", padding: "0 1rem" }}>
        <a href="#" style={{ textDecoration: "none", color: "#666", fontSize: "0.9rem" }}>
          &larr; Back to tools
        </a>
        <h1 style={{ marginTop: "0.5rem" }}>{activeTool.name}</h1>
        <ToolPage id={activeTool.id} />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: "2rem auto", fontFamily: "system-ui", padding: "0 1rem" }}>
      <h1>Smelter Tools</h1>
      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
        {TOOLS.map((tool) => (
          <a
            key={tool.id}
            href={`#${tool.id}`}
            style={{
              display: "block",
              padding: "1.5rem",
              border: "1px solid #e0e0e0",
              borderRadius: 8,
              textDecoration: "none",
              color: "inherit",
              transition: "box-shadow 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.1)")}
            onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "none")}
          >
            <h2 style={{ margin: "0 0 0.5rem" }}>{tool.name}</h2>
            <p style={{ margin: 0, color: "#666" }}>{tool.description}</p>
          </a>
        ))}
      </div>
    </div>
  );
}
