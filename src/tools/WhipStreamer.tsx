import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { useSessionInput } from "../useSessionInput.ts";
import SuggestInput, { saveToHistory } from "../SuggestInput.tsx";
import { createPeerConnection, negotiate } from "../webrtc.ts";

const NONE = "none";
const SCREEN = "screen";
const CAMERA = "camera";
const MICROPHONE = "microphone";

const RESOLUTIONS: Record<string, { label: string; width?: number; height?: number }> = {
  auto: { label: "Auto" },
  "2160p": { label: "2160p (4K)", width: 3840, height: 2160 },
  "1440p": { label: "1440p", width: 2560, height: 1440 },
  "1080p": { label: "1080p", width: 1920, height: 1080 },
  "720p": { label: "720p", width: 1280, height: 720 },
  "480p": { label: "480p", width: 854, height: 480 },
  "360p": { label: "360p", width: 640, height: 360 },
};

const FRAMERATES: Record<string, { label: string; fps?: number }> = {
  auto: { label: "Auto" },
  "60": { label: "60 fps", fps: 60 },
  "30": { label: "30 fps", fps: 30 },
  "24": { label: "24 fps", fps: 24 },
  "15": { label: "15 fps", fps: 15 },
};

const VIDEO_BITRATES: Record<string, { label: string; bps?: number }> = {
  auto: { label: "Auto" },
  "25000": { label: "25 Mbps", bps: 25_000_000 },
  "15000": { label: "15 Mbps", bps: 15_000_000 },
  "8000": { label: "8 Mbps", bps: 8_000_000 },
  "5000": { label: "5 Mbps", bps: 5_000_000 },
  "2500": { label: "2.5 Mbps", bps: 2_500_000 },
  "1000": { label: "1 Mbps", bps: 1_000_000 },
  "500": { label: "500 kbps", bps: 500_000 },
};

const AUDIO_BITRATES: Record<string, { label: string; bps?: number }> = {
  auto: { label: "Auto" },
  "256": { label: "256 kbps", bps: 256_000 },
  "192": { label: "192 kbps", bps: 192_000 },
  "128": { label: "128 kbps", bps: 128_000 },
  "96": { label: "96 kbps", bps: 96_000 },
  "64": { label: "64 kbps", bps: 64_000 },
  "32": { label: "32 kbps", bps: 32_000 },
};

function videoConstraints(resolution: string, framerate: string): MediaTrackConstraints {
  const r = RESOLUTIONS[resolution];
  const f = FRAMERATES[framerate];
  const out: MediaTrackConstraints = {};
  if (r?.width !== undefined) out.width = { ideal: r.width };
  if (r?.height !== undefined) out.height = { ideal: r.height };
  if (f?.fps !== undefined) out.frameRate = { ideal: f.fps };
  return out;
}

async function getVideoTrack(
  source: string,
  resolution: string,
  framerate: string,
): Promise<MediaStreamTrack | null> {
  if (source === NONE) return null;
  const res = videoConstraints(resolution, framerate);
  if (source === SCREEN) {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { ...res } });
    return s.getVideoTracks()[0] ?? null;
  }
  const constraint: MediaTrackConstraints =
    source === CAMERA ? { ...res } : { deviceId: { exact: source }, ...res };
  const s = await navigator.mediaDevices.getUserMedia({ video: constraint });
  return s.getVideoTracks()[0] ?? null;
}

async function applyMaxBitrate(sender: RTCRtpSender, bps: number | undefined) {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  for (const enc of params.encodings) {
    if (bps === undefined) delete enc.maxBitrate;
    else enc.maxBitrate = bps;
  }
  try {
    await sender.setParameters(params);
  } catch {
    // ignore — some browsers reject mid-call changes
  }
}

function selectOptions<T extends { label: string }>(
  rec: Record<string, T>,
): { value: string; label: string }[] {
  return Object.entries(rec).map(([value, { label }]) => ({ value, label }));
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
  resolution: string,
  framerate: string,
): Promise<{ video: MediaStreamTrack | null; audio: MediaStreamTrack | null }> {
  if (videoSource === SCREEN && audioSource === SCREEN) {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { ...videoConstraints(resolution, framerate) },
      audio: true,
    });
    return {
      video: s.getVideoTracks()[0] ?? null,
      audio: s.getAudioTracks()[0] ?? null,
    };
  }
  const [video, audio] = await Promise.all([
    getVideoTrack(videoSource, resolution, framerate),
    getAudioTrack(audioSource),
  ]);
  return { video, audio };
}

export default function WhipStreamer({ params }: { params: URLSearchParams }) {
  const [url, setUrl] = useSessionInput("whip:url", params, "url");
  const [token, setToken] = useSessionInput("whip:token", params, "token");
  const [videoSource, setVideoSource] = useState<string>(SCREEN);
  const [audioSource, setAudioSource] = useState<string>(NONE);
  const [resolution, setResolution] = useState<string>("auto");
  const [framerate, setFramerate] = useState<string>("auto");
  const [videoBitrate, setVideoBitrate] = useState<string>("auto");
  const [audioBitrate, setAudioBitrate] = useState<string>("auto");
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
      tracks = await acquireInitialTracks(videoSource, audioSource, resolution, framerate);
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

      await applyMaxBitrate(videoTransceiver.sender, VIDEO_BITRATES[videoBitrate]?.bps);
      await applyMaxBitrate(audioTransceiver.sender, AUDIO_BITRATES[audioBitrate]?.bps);

      updatePreview();
      setStreaming(true);
      setStatus("Streaming");
    } catch (err) {
      cleanup();
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [
    url,
    token,
    videoSource,
    audioSource,
    resolution,
    framerate,
    videoBitrate,
    audioBitrate,
    cleanup,
    updatePreview,
    refreshDevices,
  ]);

  const handleVideoSourceChange = useCallback(
    async (newSource: string) => {
      setVideoSource(newSource);
      if (!pcRef.current || !videoSenderRef.current) return;
      setStatus("Switching video source...");
      try {
        const newTrack = await getVideoTrack(newSource, resolution, framerate);
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
    [resolution, framerate, updatePreview, refreshDevices],
  );

  const handleResolutionChange = useCallback(
    async (newResolution: string) => {
      setResolution(newResolution);
      if (!pcRef.current || !videoSenderRef.current || videoSource === NONE) return;
      setStatus("Switching resolution...");
      try {
        const newTrack = await getVideoTrack(videoSource, newResolution, framerate);
        currentVideoTrackRef.current?.stop();
        currentVideoTrackRef.current = newTrack;
        await videoSenderRef.current.replaceTrack(newTrack);
        updatePreview();
        setStatus("Streaming");
      } catch (err) {
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [videoSource, framerate, updatePreview],
  );

  const handleFramerateChange = useCallback(
    async (newFramerate: string) => {
      setFramerate(newFramerate);
      if (!pcRef.current || !videoSenderRef.current || videoSource === NONE) return;
      setStatus("Switching framerate...");
      try {
        const newTrack = await getVideoTrack(videoSource, resolution, newFramerate);
        currentVideoTrackRef.current?.stop();
        currentVideoTrackRef.current = newTrack;
        await videoSenderRef.current.replaceTrack(newTrack);
        updatePreview();
        setStatus("Streaming");
      } catch (err) {
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [videoSource, resolution, updatePreview],
  );

  const handleVideoBitrateChange = useCallback(async (newBitrate: string) => {
    setVideoBitrate(newBitrate);
    if (videoSenderRef.current) {
      await applyMaxBitrate(videoSenderRef.current, VIDEO_BITRATES[newBitrate]?.bps);
    }
  }, []);

  const handleAudioBitrateChange = useCallback(async (newBitrate: string) => {
    setAudioBitrate(newBitrate);
    if (audioSenderRef.current) {
      await applyMaxBitrate(audioSenderRef.current, AUDIO_BITRATES[newBitrate]?.bps);
    }
  }, []);

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
          flexShrink: 0,
        }}
      >
        <OptionGroup label="Video">
          <SourceSelect
            label="Source"
            value={videoSource}
            options={videoOptions}
            onChange={handleVideoSourceChange}
          />
          <SourceSelect
            label="Resolution"
            value={resolution}
            options={selectOptions(RESOLUTIONS)}
            onChange={handleResolutionChange}
          />
          <SourceSelect
            label="Framerate"
            value={framerate}
            options={selectOptions(FRAMERATES)}
            onChange={handleFramerateChange}
          />
          <SourceSelect
            label="Max bitrate"
            value={videoBitrate}
            options={selectOptions(VIDEO_BITRATES)}
            onChange={handleVideoBitrateChange}
          />
        </OptionGroup>
        <OptionGroup label="Audio">
          <SourceSelect
            label="Source"
            value={audioSource}
            options={audioOptions}
            onChange={handleAudioSourceChange}
          />
          <SourceSelect
            label="Max bitrate"
            value={audioBitrate}
            options={selectOptions(AUDIO_BITRATES)}
            onChange={handleAudioBitrateChange}
          />
        </OptionGroup>
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

function OptionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset
      style={{
        flex: 1,
        minWidth: 280,
        border: "1px solid var(--border, #444)",
        borderRadius: 6,
        padding: "0.5rem 1rem 1rem",
        margin: 0,
        display: "flex",
        flexWrap: "wrap",
        gap: "1rem",
        alignItems: "flex-end",
      }}
    >
      <legend
        style={{
          padding: "0 0.5rem",
          fontSize: "0.85rem",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </legend>
      {children}
    </fieldset>
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
