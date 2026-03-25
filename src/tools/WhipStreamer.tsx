import { useState, useRef, useCallback, useEffect } from "react";
import { useSessionInput } from "../useSessionInput.ts";
import SuggestInput, { saveToHistory } from "../SuggestInput.tsx";
import { createPeerConnection, negotiate } from "../webrtc.ts";

async function connectWhip(endpointUrl: string, bearerToken: string, stream: MediaStream) {
  const pc = createPeerConnection();

  const negotiationNeeded = new Promise<void>((res) => {
    pc.addEventListener("negotiationneeded", () => res());
  });

  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];
  if (videoTrack) {
    pc.addTransceiver(videoTrack, {
      direction: "sendonly",
      sendEncodings: [{ priority: "high", scaleResolutionDownBy: 1.0 }],
    });
  }
  if (audioTrack) {
    pc.addTransceiver(audioTrack, { direction: "sendonly" });
  }

  await negotiationNeeded;
  await negotiate(pc, endpointUrl, bearerToken);

  return { stream, pc };
}

type SourceType = "screen" | "screen-no-audio" | "camera" | "camera-no-audio";

const SOURCE_LABELS: Record<SourceType, string> = {
  screen: "Screen share (audio + video)",
  "screen-no-audio": "Screen share (video only)",
  camera: "Camera (audio + video)",
  "camera-no-audio": "Camera (video only)",
};

async function getMediaStream(source: SourceType): Promise<MediaStream> {
  switch (source) {
    case "screen":
      return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    case "screen-no-audio":
      return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    case "camera":
      return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    case "camera-no-audio":
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
}

export default function WhipStreamer({ params }: { params: URLSearchParams }) {
  const [url, setUrl] = useSessionInput("whip:url", params, "url");
  const [token, setToken] = useSessionInput("whip:token", params, "token");
  const [status, setStatus] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const connectionRef = useRef<{ stream: MediaStream; pc: RTCPeerConnection } | null>(null);

  const cleanup = useCallback(() => {
    if (connectionRef.current) {
      connectionRef.current.stream.getTracks().forEach((t) => t.stop());
      connectionRef.current.pc.close();
      connectionRef.current = null;
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startStream = useCallback(
    async (source: SourceType) => {
      if (!url) {
        setStatus("Please enter a WHIP endpoint URL.");
        return;
      }
      cleanup();
      saveToHistory("whip:url", url);
      saveToHistory("whip:token", token);
      setStatus("Connecting...");
      try {
        const stream = await getMediaStream(source);
        const conn = await connectWhip(url, token, stream);
        connectionRef.current = conn;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setStatus("Streaming");
      } catch (err) {
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [url, token, cleanup],
  );

  return (
    <>
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <SuggestInput
          historyKey="whip:url"
          value={url}
          onChange={setUrl}
          placeholder="http://localhost:8080/whip/..."
          label="WHIP Endpoint URL"
        />
        <SuggestInput
          historyKey="whip:token"
          value={token}
          onChange={setToken}
          placeholder="token"
          label="Bearer Token (optional)"
        />
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        {(Object.entries(SOURCE_LABELS) as [SourceType, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => startStream(key)}
            style={{ padding: "0.6rem 1rem", fontSize: "0.9rem", cursor: "pointer" }}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => {
            cleanup();
            setStatus(null);
            if (videoRef.current) videoRef.current.srcObject = null;
          }}
          style={{
            padding: "0.6rem 1rem",
            fontSize: "0.9rem",
            cursor: "pointer",
            marginLeft: "auto",
          }}
        >
          Stop
        </button>
      </div>

      {status && (
        <p style={{ color: status.startsWith("Error") ? "#d32f2f" : "#666", margin: "0 0 1rem" }}>
          {status}
        </p>
      )}

      <div
        style={{
          background: "#000",
          borderRadius: 8,
          overflow: "hidden",
          aspectRatio: "16/9",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          controls
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </>
  );
}
