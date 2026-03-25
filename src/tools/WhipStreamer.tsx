import { useState, useRef, useCallback, useEffect } from "react";

async function gatherICECandidates(pc: RTCPeerConnection): Promise<RTCSessionDescription | null> {
  return new Promise((res) => {
    setTimeout(() => res(pc.localDescription), 2000);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        res(pc.localDescription);
      }
    };
  });
}

async function postSdpOffer(endpoint: string, sdpOffer: string, token: string) {
  const response = await fetch(endpoint, {
    method: "POST",
    mode: "cors",
    headers: {
      "content-type": "application/sdp",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: sdpOffer,
  });

  if (response.status === 201) {
    const locationHeader = response.headers.get("Location");
    const location = locationHeader ? new URL(locationHeader, endpoint).toString() : endpoint;
    return { sdp: await response.text(), location };
  }
  throw new Error(await response.text());
}

async function establishWhipConnection(pc: RTCPeerConnection, endpoint: string, token: string) {
  await pc.setLocalDescription(await pc.createOffer());
  const offer = await gatherICECandidates(pc);
  if (!offer) throw new Error("Failed to gather ICE candidates for offer");

  const { sdp: sdpAnswer, location } = await postSdpOffer(endpoint, offer.sdp!, token);
  await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: sdpAnswer }));
  return location ?? endpoint;
}

async function connect(endpointUrl: string, bearerToken: string, stream: MediaStream) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    bundlePolicy: "max-bundle",
  });

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
  await establishWhipConnection(pc, endpointUrl, bearerToken);

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

export default function WhipStreamer() {
  const [url, setUrl] = useState(
    () => new URLSearchParams(window.location.search).get("whip_url") ?? "",
  );
  const [token, setToken] = useState(
    () => new URLSearchParams(window.location.search).get("whip_token") ?? "",
  );
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
      setStatus("Connecting...");
      try {
        const stream = await getMediaStream(source);
        const conn = await connect(url, token, stream);
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
        <div style={{ flex: 1, minWidth: 200 }}>
          <label style={{ display: "block", marginBottom: 4, fontSize: "0.85rem", color: "#666" }}>
            WHIP Endpoint URL
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:8080/whip/..."
            style={{ width: "100%", padding: "0.5rem", fontSize: "1rem", boxSizing: "border-box" }}
          />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label style={{ display: "block", marginBottom: 4, fontSize: "0.85rem", color: "#666" }}>
            Bearer Token (optional)
          </label>
          <input
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="token"
            style={{ width: "100%", padding: "0.5rem", fontSize: "1rem", boxSizing: "border-box" }}
          />
        </div>
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
