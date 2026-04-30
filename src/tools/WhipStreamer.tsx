import { useState, useRef, useCallback, useEffect } from "react";
import { useSessionInput } from "../useSessionInput.ts";
import SuggestInput, { saveToHistory } from "../SuggestInput.tsx";
import { createPeerConnection, negotiate } from "../webrtc.ts";

type VideoSource = "none" | "camera" | "screen";
type AudioSource = "none" | "microphone" | "screen";

const VIDEO_SOURCE_OPTIONS: { value: VideoSource; label: string }[] = [
  { value: "none", label: "None" },
  { value: "camera", label: "Camera" },
  { value: "screen", label: "Screen share" },
];

const AUDIO_SOURCE_OPTIONS: { value: AudioSource; label: string }[] = [
  { value: "none", label: "None" },
  { value: "microphone", label: "Microphone" },
  { value: "screen", label: "Screen audio" },
];

async function getVideoTrack(source: VideoSource): Promise<MediaStreamTrack | null> {
  if (source === "none") return null;
  if (source === "camera") {
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    return s.getVideoTracks()[0] ?? null;
  }
  const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
  return s.getVideoTracks()[0] ?? null;
}

async function getAudioTrack(source: AudioSource): Promise<MediaStreamTrack | null> {
  if (source === "none") return null;
  if (source === "microphone") {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    return s.getAudioTracks()[0] ?? null;
  }
  const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  s.getVideoTracks().forEach((t) => t.stop());
  return s.getAudioTracks()[0] ?? null;
}

async function acquireInitialTracks(
  videoSource: VideoSource,
  audioSource: AudioSource,
): Promise<{ video: MediaStreamTrack | null; audio: MediaStreamTrack | null }> {
  if (videoSource === "screen" && audioSource === "screen") {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    return {
      video: s.getVideoTracks()[0] ?? null,
      audio: s.getAudioTracks()[0] ?? null,
    };
  }
  const [video, audio] = await Promise.all([
    getVideoTrack(videoSource),
    getAudioTrack(audioSource),
  ]);
  return { video, audio };
}

export default function WhipStreamer({ params }: { params: URLSearchParams }) {
  const [url, setUrl] = useSessionInput("whip:url", params, "url");
  const [token, setToken] = useSessionInput("whip:token", params, "token");
  const [videoSource, setVideoSource] = useState<VideoSource>("screen");
  const [audioSource, setAudioSource] = useState<AudioSource>("none");
  const [status, setStatus] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const audioSenderRef = useRef<RTCRtpSender | null>(null);
  const currentVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const currentAudioTrackRef = useRef<MediaStreamTrack | null>(null);

  const updatePreview = useCallback(() => {
    if (!videoRef.current) return;
    const stream = new MediaStream();
    if (currentVideoTrackRef.current) stream.addTrack(currentVideoTrackRef.current);
    if (currentAudioTrackRef.current) stream.addTrack(currentAudioTrackRef.current);
    videoRef.current.srcObject = stream;
  }, []);

  const cleanup = useCallback(() => {
    currentVideoTrackRef.current?.stop();
    currentVideoTrackRef.current = null;
    currentAudioTrackRef.current?.stop();
    currentAudioTrackRef.current = null;
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    videoSenderRef.current = null;
    audioSenderRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStreaming(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startStream = useCallback(async () => {
    if (!url) {
      setStatus("Please enter a WHIP endpoint URL.");
      return;
    }
    if (videoSource === "none" && audioSource === "none") {
      setStatus("Select at least one media source.");
      return;
    }
    cleanup();
    saveToHistory("whip:url", url);
    saveToHistory("whip:token", token);
    setStatus("Acquiring sources...");

    let tracks: { video: MediaStreamTrack | null; audio: MediaStreamTrack | null };
    try {
      tracks = await acquireInitialTracks(videoSource, audioSource);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    currentVideoTrackRef.current = tracks.video;
    currentAudioTrackRef.current = tracks.audio;

    setStatus("Connecting...");
    try {
      const pc = createPeerConnection();
      pcRef.current = pc;

      const negotiationNeeded = new Promise<void>((res) => {
        pc.addEventListener("negotiationneeded", () => res());
      });

      const videoTransceiver = pc.addTransceiver("video", {
        direction: "sendonly",
        sendEncodings: [{ priority: "high", scaleResolutionDownBy: 1.0 }],
      });
      const audioTransceiver = pc.addTransceiver("audio", { direction: "sendonly" });
      videoSenderRef.current = videoTransceiver.sender;
      audioSenderRef.current = audioTransceiver.sender;

      if (tracks.video) await videoTransceiver.sender.replaceTrack(tracks.video);
      if (tracks.audio) await audioTransceiver.sender.replaceTrack(tracks.audio);

      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          cleanup();
          setStatus("Connection lost");
        }
      });

      await negotiationNeeded;
      await negotiate(pc, url, token);

      updatePreview();
      setStreaming(true);
      setStatus("Streaming");
    } catch (err) {
      cleanup();
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [url, token, videoSource, audioSource, cleanup, updatePreview]);

  const handleVideoSourceChange = useCallback(
    async (newSource: VideoSource) => {
      setVideoSource(newSource);
      if (!pcRef.current || !videoSenderRef.current) return;
      setStatus("Switching video source...");
      try {
        const newTrack = await getVideoTrack(newSource);
        currentVideoTrackRef.current?.stop();
        currentVideoTrackRef.current = newTrack;
        await videoSenderRef.current.replaceTrack(newTrack);
        updatePreview();
        setStatus("Streaming");
      } catch (err) {
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [updatePreview],
  );

  const handleAudioSourceChange = useCallback(
    async (newSource: AudioSource) => {
      setAudioSource(newSource);
      if (!pcRef.current || !audioSenderRef.current) return;
      setStatus("Switching audio source...");
      try {
        const newTrack = await getAudioTrack(newSource);
        currentAudioTrackRef.current?.stop();
        currentAudioTrackRef.current = newTrack;
        await audioSenderRef.current.replaceTrack(newTrack);
        updatePreview();
        setStatus("Streaming");
      } catch (err) {
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [updatePreview],
  );

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

      <div
        style={{
          display: "flex",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "1rem",
          alignItems: "flex-end",
          flexShrink: 0,
        }}
      >
        <SourceSelect
          label="Video source"
          value={videoSource}
          options={VIDEO_SOURCE_OPTIONS}
          onChange={handleVideoSourceChange}
        />
        <SourceSelect
          label="Audio source"
          value={audioSource}
          options={AUDIO_SOURCE_OPTIONS}
          onChange={handleAudioSourceChange}
        />
      </div>

      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          marginBottom: "1rem",
          flexShrink: 0,
        }}
      >
        {!streaming ? (
          <button
            onClick={startStream}
            style={{ padding: "0.5rem 1.5rem", fontSize: "1rem", cursor: "pointer" }}
          >
            Start
          </button>
        ) : (
          <button
            onClick={() => {
              cleanup();
              setStatus(null);
            }}
            style={{ padding: "0.5rem 1.5rem", fontSize: "1rem", cursor: "pointer" }}
          >
            Stop
          </button>
        )}
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
          muted
          style={{ maxWidth: "100%", maxHeight: "100%", width: "100%", height: "100%" }}
        />
      </div>
    </>
  );
}

function SourceSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 200 }}>
      <label
        style={{
          marginBottom: 4,
          fontSize: "0.85rem",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        style={{ width: "100%", padding: "0.5rem", fontSize: "1rem", boxSizing: "border-box" }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
