import { useState, useRef, useCallback, useEffect } from "react";
import { useSessionInput } from "../../ui/useSessionInput.ts";
import SuggestInput, { saveToHistory } from "../../ui/SuggestInput.tsx";
import {
  Checkbox,
  OptionGroup,
  Select,
  deviceOptions,
  groupRowStyle,
  selectOptions,
} from "../../ui/form.tsx";
import { createPeerConnection, negotiate } from "../../lib/webrtc.ts";
import type { ToolMeta } from "../registry.ts";

const NONE = "none";
const CAMERA = "camera";
const SCREEN = "screen";
type Source = typeof NONE | typeof CAMERA | typeof SCREEN;

const SOURCES: { value: Source; label: string }[] = [
  { value: NONE, label: "None" },
  { value: CAMERA, label: "Camera + microphone" },
  { value: SCREEN, label: "Screen" },
];

type ScreenAudio = "screen" | "microphone";
const SCREEN_AUDIO: { value: ScreenAudio; label: string }[] = [
  { value: "screen", label: "Screen audio" },
  { value: "microphone", label: "Microphone" },
];

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

const DEGRADATION_PREFERENCES: Record<string, { label: string; value?: RTCDegradationPreference }> =
  {
    default: { label: "Default" },
    balanced: { label: "Balanced", value: "balanced" },
    "maintain-framerate": { label: "Maintain framerate", value: "maintain-framerate" },
    "maintain-resolution": { label: "Maintain resolution", value: "maintain-resolution" },
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

async function applyDegradationPreference(
  sender: RTCRtpSender,
  preference: RTCDegradationPreference | undefined,
) {
  const params = sender.getParameters();
  params.degradationPreference = preference;
  try {
    await sender.setParameters(params);
  } catch {
    // ignore — not supported in all browsers
  }
}

// Chromium's screen-capture extensions, not in TypeScript's DOM types yet. Without a
// controller set to "no-focus-change" the browser switches to a tab or window the moment it
// is picked for sharing. Same options as @moq/publish uses.
interface CaptureController {
  setFocusBehavior(behavior: "focus-captured-surface" | "no-focus-change"): void;
}
const CaptureControllerCtor = (globalThis as { CaptureController?: new () => CaptureController })
  .CaptureController;
type DisplayMediaOptions = DisplayMediaStreamOptions & {
  controller?: CaptureController;
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
};

function stopTracks(stream: MediaStream) {
  stream.getTracks().forEach((t) => t.stop());
}

/**
 * Runs one capture for an effect and returns the effect's cleanup, which stops the captured
 * tracks (or the late result of a capture the user has since moved on from) and drops the
 * error of a capture that failed.
 */
function runCapture(
  capture: () => Promise<MediaStream>,
  setStream: (stream: MediaStream | null) => void,
  setError: (error: string | null) => void,
): () => void {
  let cancelled = false;
  let failed = false;
  let stream: MediaStream | null = null;
  capture().then(
    (s) => {
      if (cancelled) {
        stopTracks(s);
        return;
      }
      stream = s;
      setStream(s);
      setError(null);
    },
    (err) => {
      if (cancelled) return;
      failed = true;
      setError(err instanceof Error ? err.message : String(err));
    },
  );
  return () => {
    cancelled = true;
    if (stream) stopTracks(stream);
    if (failed) setError(null);
    setStream(null);
  };
}

export const meta: ToolMeta = {
  id: "whip-streamer",
  name: "WHIP Streamer",
  description: "Stream screen or camera via WebRTC WHIP",
  scrollable: false,
};

export default function WhipStreamer({ params }: { params: URLSearchParams }) {
  const [url, setUrl] = useSessionInput("whip:url", params, "url");
  const [token, setToken] = useSessionInput("whip:token", params, "token");

  // ---- Source -------------------------------------------------------------
  const [source, setSource] = useState<Source>(NONE);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [screenAudio, setScreenAudio] = useState<ScreenAudio>("screen");

  // ---- Capture ------------------------------------------------------------
  const [cameraDevice, setCameraDevice] = useState("");
  const [micDevice, setMicDevice] = useState("");
  const [resolution, setResolution] = useState<string>("auto");
  const [framerate, setFramerate] = useState<string>("auto");
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [autoGainControl, setAutoGainControl] = useState(true);

  // ---- Encoding -----------------------------------------------------------
  const [videoBitrate, setVideoBitrate] = useState<string>("auto");
  const [audioBitrate, setAudioBitrate] = useState<string>("auto");
  const [degradationPreference, setDegradationPreference] = useState<string>("default");

  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [displayStream, setDisplayStream] = useState<MediaStream | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const audioSenderRef = useRef<RTCRtpSender | null>(null);

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

  // ---- Capture whatever the form selects, as soon as it is selected --------
  // Screen, camera and microphone are captured independently, so changing one device does not
  // re-open the others. Screen video and screen audio come from one getDisplayMedia call
  // (the browser only offers its audio alongside a picked surface).
  const screenAudioWanted = source === SCREEN && audioEnabled && screenAudio === "screen";
  const displayWanted = source === SCREEN && (videoEnabled || screenAudioWanted);
  const cameraWanted = source === CAMERA && videoEnabled;
  const micWanted =
    audioEnabled && (source === CAMERA || (source === SCREEN && screenAudio === "microphone"));

  useEffect(() => {
    if (!displayWanted) return;
    const capture = async () => {
      const controller = CaptureControllerCtor ? new CaptureControllerCtor() : undefined;
      controller?.setFocusBehavior("no-focus-change");
      const options: DisplayMediaOptions = {
        video: true,
        audio: screenAudioWanted,
        controller,
        preferCurrentTab: false,
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
      };
      const s = await navigator.mediaDevices.getDisplayMedia(options);
      // The browser's own "Stop sharing" button ends the track without going through us.
      s.getVideoTracks()[0]?.addEventListener("ended", () => setSource(NONE));
      return s;
    };
    return runCapture(capture, setDisplayStream, setCaptureError);
  }, [displayWanted, screenAudioWanted]);

  useEffect(() => {
    if (!cameraWanted) return;
    const capture = () =>
      navigator.mediaDevices.getUserMedia({
        video: cameraDevice ? { deviceId: { exact: cameraDevice } } : true,
      });
    const setStream = (s: MediaStream | null) => {
      setCameraStream(s);
      // Device labels only show up once the page holds a capture permission.
      if (s) refreshDevices();
    };
    return runCapture(capture, setStream, setCaptureError);
  }, [cameraWanted, cameraDevice, refreshDevices]);

  useEffect(() => {
    if (!micWanted) return;
    const capture = () =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          ...(micDevice ? { deviceId: { exact: micDevice } } : {}),
          echoCancellation,
          noiseSuppression,
          autoGainControl,
        },
      });
    const setStream = (s: MediaStream | null) => {
      setMicStream(s);
      if (s) refreshDevices();
    };
    return runCapture(capture, setStream, setCaptureError);
  }, [micWanted, micDevice, echoCancellation, noiseSuppression, autoGainControl, refreshDevices]);

  const videoTrack =
    (displayWanted && videoEnabled
      ? displayStream?.getVideoTracks()[0]
      : cameraWanted
        ? cameraStream?.getVideoTracks()[0]
        : undefined) ?? null;
  const audioTrack =
    (screenAudioWanted
      ? displayStream?.getAudioTracks()[0]
      : micWanted
        ? micStream?.getAudioTracks()[0]
        : undefined) ?? null;

  // Resolution and framerate are applied to the live track rather than re-captured, so
  // changing them does not bring the screen picker back up.
  useEffect(() => {
    videoTrack?.applyConstraints(videoConstraints(resolution, framerate)).catch((err) => {
      setCaptureError(err instanceof Error ? err.message : String(err));
    });
  }, [videoTrack, resolution, framerate]);

  // ---- Feed the tracks to the preview and, while streaming, to the senders -
  useEffect(() => {
    if (!videoRef.current) return;
    const stream = new MediaStream();
    if (videoTrack) stream.addTrack(videoTrack);
    if (audioTrack) stream.addTrack(audioTrack);
    videoRef.current.srcObject = stream.getTracks().length > 0 ? stream : null;
  }, [videoTrack, audioTrack]);

  useEffect(() => {
    videoSenderRef.current?.replaceTrack(videoTrack).catch(() => {});
  }, [videoTrack]);
  useEffect(() => {
    audioSenderRef.current?.replaceTrack(audioTrack).catch(() => {});
  }, [audioTrack]);

  const stopStream = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    videoSenderRef.current = null;
    audioSenderRef.current = null;
    setStreaming(false);
  }, []);

  useEffect(() => stopStream, [stopStream]);

  const startStream = useCallback(async () => {
    if (!url) {
      setStatus("Please enter a WHIP endpoint URL.");
      return;
    }
    if (!videoTrack && !audioTrack) {
      setStatus("Select at least one media source.");
      return;
    }
    stopStream();
    saveToHistory("whip:url", url);
    saveToHistory("whip:token", token);
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

      if (videoTrack) await videoTransceiver.sender.replaceTrack(videoTrack);
      if (audioTrack) await audioTransceiver.sender.replaceTrack(audioTrack);

      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          stopStream();
          setStatus("Connection lost");
        }
      });

      await negotiationNeeded;
      await negotiate(pc, url, token);

      await applyMaxBitrate(videoTransceiver.sender, VIDEO_BITRATES[videoBitrate]?.bps);
      await applyMaxBitrate(audioTransceiver.sender, AUDIO_BITRATES[audioBitrate]?.bps);
      await applyDegradationPreference(
        videoTransceiver.sender,
        DEGRADATION_PREFERENCES[degradationPreference]?.value,
      );

      setStreaming(true);
      setStatus("Streaming");
    } catch (err) {
      stopStream();
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [
    url,
    token,
    videoTrack,
    audioTrack,
    videoBitrate,
    audioBitrate,
    degradationPreference,
    stopStream,
  ]);

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

  const handleDegradationPreferenceChange = useCallback(async (newPref: string) => {
    setDegradationPreference(newPref);
    if (videoSenderRef.current) {
      await applyDegradationPreference(
        videoSenderRef.current,
        DEGRADATION_PREFERENCES[newPref]?.value,
      );
    }
  }, []);

  const message = captureError ? `Error: ${captureError}` : status;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
      }}
    >
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
          placeholder="http://localhost:9000/whip/..."
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

      <div style={groupRowStyle}>
        <OptionGroup label="Source">
          <Select label="Source" value={source} options={SOURCES} onChange={setSource} />
          {source === SCREEN && (
            <Select
              label="Audio source"
              value={screenAudio}
              options={SCREEN_AUDIO}
              onChange={setScreenAudio}
            />
          )}
          <Checkbox label="Video" checked={videoEnabled} onChange={setVideoEnabled} />
          <Checkbox label="Audio" checked={audioEnabled} onChange={setAudioEnabled} />
        </OptionGroup>

        <OptionGroup label="Encoding">
          <Select
            label="Video max bitrate"
            value={videoBitrate}
            options={selectOptions(VIDEO_BITRATES)}
            onChange={handleVideoBitrateChange}
          />
          <Select
            label="Degradation preference"
            value={degradationPreference}
            options={selectOptions(DEGRADATION_PREFERENCES)}
            onChange={handleDegradationPreferenceChange}
          />
          <Select
            label="Audio max bitrate"
            value={audioBitrate}
            options={selectOptions(AUDIO_BITRATES)}
            onChange={handleAudioBitrateChange}
          />
        </OptionGroup>
      </div>

      {source !== NONE && (
        <div style={groupRowStyle}>
          <OptionGroup label={source === CAMERA ? "Camera capture" : "Screen capture"}>
            {source === CAMERA && (
              <Select
                label="Device"
                value={cameraDevice}
                options={deviceOptions(videoDevices)}
                onChange={setCameraDevice}
              />
            )}
            <Select
              label="Resolution"
              value={resolution}
              options={selectOptions(RESOLUTIONS)}
              onChange={setResolution}
            />
            <Select
              label="Framerate"
              value={framerate}
              options={selectOptions(FRAMERATES)}
              onChange={setFramerate}
            />
          </OptionGroup>
          {(source === CAMERA || screenAudio === "microphone") && (
            <OptionGroup label="Microphone capture">
              <Select
                label="Device"
                value={micDevice}
                options={deviceOptions(audioDevices)}
                onChange={setMicDevice}
              />
              <Checkbox
                label="Echo cancellation"
                checked={echoCancellation}
                onChange={setEchoCancellation}
              />
              <Checkbox
                label="Noise suppression"
                checked={noiseSuppression}
                onChange={setNoiseSuppression}
              />
              <Checkbox
                label="Auto gain control"
                checked={autoGainControl}
                onChange={setAutoGainControl}
              />
            </OptionGroup>
          )}
        </div>
      )}

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
              stopStream();
              setStatus(null);
            }}
            style={{ padding: "0.5rem 1.5rem", fontSize: "1rem", cursor: "pointer" }}
          >
            Stop
          </button>
        )}
      </div>

      {message && (
        <p
          style={{
            color: message.startsWith("Error") ? "var(--error)" : "var(--text-muted)",
            margin: "0 0 1rem",
          }}
        >
          {message}
        </p>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 240,
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
    </div>
  );
}
