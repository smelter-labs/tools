import { useState, useRef, useCallback, useEffect } from "react";
import { useSessionInput } from "../useSessionInput.ts";
import SuggestInput, { saveToHistory } from "../SuggestInput.tsx";
import { createPeerConnection, negotiate } from "../webrtc.ts";

async function connectWhep(
  endpointUrl: string,
  bearerToken: string,
): Promise<{ stream: MediaStream; pc: RTCPeerConnection }> {
  const pc = createPeerConnection();

  const tracksPromise = new Promise<{ video: MediaStreamTrack; audio: MediaStreamTrack }>((res) => {
    let videoTrack: MediaStreamTrack | undefined;
    let audioTrack: MediaStreamTrack | undefined;
    pc.ontrack = (ev) => {
      if (ev.track.kind === "video") videoTrack = ev.track;
      if (ev.track.kind === "audio") audioTrack = ev.track;
      if (videoTrack && audioTrack) {
        res({ video: videoTrack, audio: audioTrack });
      }
    };
  });

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  await negotiate(pc, endpointUrl, bearerToken);

  const tracks = await tracksPromise;
  const stream = new MediaStream();
  stream.addTrack(tracks.video);
  stream.addTrack(tracks.audio);

  return { stream, pc };
}

export default function WhepPlayer({ params }: { params: URLSearchParams }) {
  const [url, setUrl] = useSessionInput("whep:url", params, "url");
  const [token, setToken] = useSessionInput("whep:token", params, "token");
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

  const connect = useCallback(async () => {
    if (!url) {
      setStatus("Please enter a WHEP endpoint URL.");
      return;
    }
    cleanup();
    saveToHistory("whep:url", url);
    saveToHistory("whep:token", token);
    setStatus("Connecting...");
    try {
      const conn = await connectWhep(url, token);
      connectionRef.current = conn;
      if (videoRef.current) {
        videoRef.current.srcObject = conn.stream;
      }
      setStatus("Playing");
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [url, token, cleanup]);

  return (
    <>
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <SuggestInput
          historyKey="whep:url"
          value={url}
          onChange={setUrl}
          placeholder="http://localhost:8080/whep/..."
          label="WHEP Endpoint URL"
        />
        <SuggestInput
          historyKey="whep:token"
          value={token}
          onChange={setToken}
          placeholder="token"
          label="Bearer Token (optional)"
        />
      </div>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button
          onClick={connect}
          style={{ padding: "0.6rem 1rem", fontSize: "0.9rem", cursor: "pointer" }}
        >
          Connect
        </button>
        <button
          onClick={() => {
            cleanup();
            setStatus(null);
            if (videoRef.current) videoRef.current.srcObject = null;
          }}
          style={{ padding: "0.6rem 1rem", fontSize: "0.9rem", cursor: "pointer" }}
        >
          Disconnect
        </button>
      </div>

      {status && (
        <p
          style={{
            color: status.startsWith("Error") ? "var(--error)" : "var(--text-muted)",
            margin: "0 0 1rem",
          }}
        >
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
