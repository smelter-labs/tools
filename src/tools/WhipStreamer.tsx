import { useState, useRef, useCallback, useEffect } from "react";
import { useSessionInput } from "../useSessionInput.ts";
import SuggestInput, { saveToHistory } from "../SuggestInput.tsx";
import { createPeerConnection, negotiate } from "../webrtc.ts";

const NONE = "none";
const SCREEN = "screen";
const CAMERA = "camera";
const MICROPHONE = "microphone";

async function getVideoTrack(source: string): Promise<MediaStreamTrack | null> {
  if (source === NONE) return null;
  if (source === SCREEN) {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    return s.getVideoTracks()[0] ?? null;
  }
  const constraint: MediaTrackConstraints =
    source === CAMERA ? {} : { deviceId: { exact: source } };
  const s = await navigator.mediaDevices.getUserMedia({ video: constraint });
  return s.getVideoTracks()[0] ?? null;
}

async function getAudioTrack(source: string): Promise<MediaStreamTrack | null> {
  if (source === NONE) return null;
  if (source === SCREEN) {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    s.getVideoTracks().forEach((t) => t.stop());
    return s.getAudioTracks()[0] ?? null;
  }
  const constraint: MediaTrackConstraints =
    source === MICROPHONE ? {} : { deviceId: { exact: source } };
  const s = await navigator.mediaDevices.getUserMedia({ audio: constraint });
  return s.getAudioTracks()[0] ?? null;
}

async function acquireInitialTracks(
  videoSource: string,
  audioSource: string,
): Promise<{ video: MediaStreamTrack | null; audio: MediaStreamTrack | null }> {
  if (videoSource === SCREEN && audioSource === SCREEN) {
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
  const [videoSource, setVideoSource] = useState<string>(SCREEN);
  const [audioSource, setAudioSource] = useState<string>(NONE);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const audioSenderRef = useRef<RTCRtpSender | null>(null);
  const currentVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const currentAudioTrackRef = useRef<MediaStreamTrack | null>(null);

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setVideoDevices(devices.filter((d) => d.kind === "videoinput"));
      setAudioDevices(devices.filter((d) => d.kind === "audioinput"));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  const namedVideoDevices = videoDevices.filter((d) => d.deviceId && d.label);
  const namedAudioDevices = audioDevices.filter((d) => d.deviceId && d.label);
  const videoOptions = [
    { value: NONE, label: "None" },
    { value: SCREEN, label: "Screen share" },
    ...(namedVideoDevices.length > 0
      ? namedVideoDevices.map((d) => ({ value: d.deviceId, label: d.label }))
      : [{ value: CAMERA, label: "Camera" }]),
  ];
  const audioOptions = [
    { value: NONE, label: "None" },
    { value: SCREEN, label: "Screen audio" },
    ...(namedAudioDevices.length > 0
      ? namedAudioDevices.map((d) => ({ value: d.deviceId, label: d.label }))
      : [{ value: MICROPHONE, label: "Microphone" }]),
  ];

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
    if (videoSource === CAMERA && tracks.video) {
      const id = tracks.video.getSettings().deviceId;
      if (id) setVideoSource(id);
    }
    if (audioSource === MICROPHONE && tracks.audio) {
      const id = tracks.audio.getSettings().deviceId;
      if (id) setAudioSource(id);
    }
    refreshDevices();

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
  }, [url, token, videoSource, audioSource, cleanup, updatePreview, refreshDevices]);

  const handleVideoSourceChange = useCallback(
    async (newSource: string) => {
      setVideoSource(newSource);
      if (!pcRef.current || !videoSenderRef.current) return;
      setStatus("Switching video source...");
      try {
        const newTrack = await getVideoTrack(newSource);
        currentVideoTrackRef.current?.stop();
        currentVideoTrackRef.current = newTrack;
        await videoSenderRef.current.replaceTrack(newTrack);
        if (newSource === CAMERA && newTrack) {
          const id = newTrack.getSettings().deviceId;
          if (id) setVideoSource(id);
        }
        updatePreview();
        refreshDevices();
        setStatus("Streaming");
      } catch (err) {
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [updatePreview, refreshDevices],
  );

  const handleAudioSourceChange = useCallback(
    async (newSource: string) => {
      setAudioSource(newSource);
      if (!pcRef.current || !audioSenderRef.current) return;
      setStatus("Switching audio source...");
      try {
        const newTrack = await getAudioTrack(newSource);
        currentAudioTrackRef.current?.stop();
        currentAudioTrackRef.current = newTrack;
        await audioSenderRef.current.replaceTrack(newTrack);
        if (newSource === MICROPHONE && newTrack) {
          const id = newTrack.getSettings().deviceId;
          if (id) setAudioSource(id);
        }
        updatePreview();
        refreshDevices();
        setStatus("Streaming");
      } catch (err) {
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [updatePreview, refreshDevices],
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
          options={videoOptions}
          onChange={handleVideoSourceChange}
        />
        <SourceSelect
          label="Audio source"
          value={audioSource}
          options={audioOptions}
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
