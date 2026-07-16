import { useState, useRef, useCallback, useEffect } from "react";
import { useSessionInput } from "../useSessionInput.ts";
import SuggestInput, { saveToHistory } from "../SuggestInput.tsx";
import { createPeerConnection, negotiate } from "../webrtc.ts";

const TRACK_TIMEOUT_MS = 10_000;

async function connectWhep(
  endpointUrl: string,
  bearerToken: string,
): Promise<{ stream: MediaStream; pc: RTCPeerConnection }> {
  const pc = createPeerConnection();
  const stream = new MediaStream();
  let onTrackAdded: (() => void) | undefined;

  pc.ontrack = (ev) => {
    stream.addTrack(ev.track);
    onTrackAdded?.();
  };

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  try {
    await negotiate(pc, endpointUrl, bearerToken);

    // We always offer both kinds, but the answer decides which ones actually carry
    // media, so an audio-only or video-only stream leaves the other one inactive.
    const expected = pc
      .getTransceivers()
      .filter((t) => t.currentDirection === "recvonly" || t.currentDirection === "sendrecv").length;
    if (expected === 0) {
      throw new Error("Server accepted neither audio nor video");
    }

    await new Promise<void>((res, rej) => {
      if (stream.getTracks().length >= expected) {
        res();
        return;
      }
      const timeout = setTimeout(
        () => rej(new Error(`Timed out waiting for ${expected} track(s) from the server`)),
        TRACK_TIMEOUT_MS,
      );
      onTrackAdded = () => {
        if (stream.getTracks().length >= expected) {
          clearTimeout(timeout);
          res();
        }
      };
    });
  } catch (err) {
    pc.close();
    throw err;
  }

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
      <div
        style={{
          display: "flex",
          gap: "1rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
          flexShrink: 0,
        }}
      >
        <SuggestInput
          historyKey="whep:url"
          value={url}
          onChange={setUrl}
          placeholder="http://localhost:9000/whep/..."
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

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexShrink: 0 }}>
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
          flex: 1,
          minHeight: 0,
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
          style={{ maxWidth: "100%", maxHeight: "100%", width: "100%", height: "100%" }}
        />
      </div>
    </>
  );
}
