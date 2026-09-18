import { useEffect, useState } from "react";
import { useValue } from "@moq/signals/react";
import * as Publish from "@moq/publish";
import { useSessionInput } from "../../ui/useSessionInput.ts";
import SuggestInput, { saveToHistory } from "../../ui/SuggestInput.tsx";
import {
  Checkbox,
  NumberField,
  OptionGroup,
  Select,
  buttonStyle,
  fieldStyle,
  groupRowStyle,
  labelStyle,
  optionalNumber,
  selectOptions,
} from "../../ui/form.tsx";
import { formatBitrate } from "../../ui/format.ts";
import { Publisher, type AnnounceMode, type SourceKind } from "./publisher.ts";
import type { ToolMeta } from "../registry.ts";

const Net = Publish.Net;

// Path the broadcast is published under when the field is left empty.
const DEFAULT_BROADCAST_PATH = "test";

const NONE = "none";
type SourceOption = SourceKind | typeof NONE;

const SOURCES: { value: SourceOption; label: string }[] = [
  { value: NONE, label: "None" },
  { value: "camera", label: "Camera + microphone" },
  { value: "screen", label: "Screen" },
  { value: "file", label: "File" },
];

const ANNOUNCE_MODES: { value: AnnounceMode; label: string }[] = [
  { value: "catalog", label: "Once the catalog is complete (Smelter)" },
  { value: "source", label: "Once a source is captured" },
  { value: "always", label: "Always" },
];

const PREVIEW_MODES: { value: Publish.Preview.Mode; label: string }[] = [
  { value: "source", label: "Source" },
  { value: "encoded", label: "Encoded (transcoded)" },
  { value: "none", label: "None" },
];

type FacingMode = "auto" | "user" | "environment";
const FACING_MODES: { value: FacingMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "user", label: "Front (user)" },
  { value: "environment", label: "Rear (environment)" },
];

// Camera constraints merge over the package default of 1280x720.
const CAPTURE_RESOLUTIONS: Record<string, { label: string; width?: number; height?: number }> = {
  auto: { label: "Default (720p)" },
  "2160p": { label: "2160p (4K)", width: 3840, height: 2160 },
  "1440p": { label: "1440p", width: 2560, height: 1440 },
  "1080p": { label: "1080p", width: 1920, height: 1080 },
  "720p": { label: "720p", width: 1280, height: 720 },
  "480p": { label: "480p", width: 854, height: 480 },
  "360p": { label: "360p", width: 640, height: 360 },
};

// Encoder cap on the number of pixels; the encoder downscales the capture to fit.
const MAX_PIXELS: Record<string, { label: string; pixels?: number }> = {
  auto: { label: "Auto (capture size)" },
  "2160p": { label: "2160p (4K)", pixels: 3840 * 2160 },
  "1440p": { label: "1440p", pixels: 2560 * 1440 },
  "1080p": { label: "1080p", pixels: 1920 * 1080 },
  "720p": { label: "720p", pixels: 1280 * 720 },
  "480p": { label: "480p", pixels: 854 * 480 },
  "360p": { label: "360p", pixels: 640 * 360 },
};

const FRAMERATES: Record<string, { label: string; fps?: number }> = {
  auto: { label: "Auto" },
  "60": { label: "60 fps", fps: 60 },
  "30": { label: "30 fps", fps: 30 },
  "24": { label: "24 fps", fps: 24 },
  "15": { label: "15 fps", fps: 15 },
};

// Codec prefixes: the encoder picks the first supported profile matching the prefix.
const VIDEO_CODECS: Record<string, { label: string; codec?: string }> = {
  auto: { label: "Auto" },
  avc1: { label: "H.264 (avc1)", codec: "avc1" },
  hev1: { label: "H.265 (hev1)", codec: "hev1" },
  vp09: { label: "VP9 (vp09)", codec: "vp09" },
  av01: { label: "AV1 (av01)", codec: "av01" },
  vp8: { label: "VP8", codec: "vp8" },
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

type AudioCodecKind = "opus" | "aac";
const AUDIO_CODECS: { value: AudioCodecKind; label: string }[] = [
  { value: "opus", label: "Opus" },
  { value: "aac", label: "AAC" },
];

const AUDIO_BITRATES: Record<string, { label: string; bps?: number }> = {
  auto: { label: "Auto" },
  "256": { label: "256 kbps", bps: 256_000 },
  "192": { label: "192 kbps", bps: 192_000 },
  "128": { label: "128 kbps", bps: 128_000 },
  "96": { label: "96 kbps", bps: 96_000 },
  "64": { label: "64 kbps", bps: 64_000 },
  "32": { label: "32 kbps", bps: 32_000 },
};

const OPUS_FRAME_DURATIONS: Record<string, { label: string; ms?: number }> = {
  auto: { label: "Auto" },
  "2.5": { label: "2.5 ms", ms: 2.5 },
  "5": { label: "5 ms", ms: 5 },
  "10": { label: "10 ms", ms: 10 },
  "20": { label: "20 ms", ms: 20 },
  "40": { label: "40 ms", ms: 40 },
  "60": { label: "60 ms", ms: 60 },
};

const SAMPLE_RATES: Record<string, { label: string; hz?: number }> = {
  auto: { label: "Auto (track rate)" },
  "48000": { label: "48 kHz", hz: 48_000 },
  "44100": { label: "44.1 kHz", hz: 44_100 },
  "16000": { label: "16 kHz", hz: 16_000 },
};

const CHANNEL_COUNTS: Record<string, { label: string; channels?: number }> = {
  auto: { label: "Auto" },
  "1": { label: "Mono", channels: 1 },
  "2": { label: "Stereo", channels: 2 },
};

export const meta: ToolMeta = {
  id: "moq-publish",
  name: "MoQ Publish",
  description: "Publish camera, screen or file over MoQ with the @moq/publish library",
  scrollable: false,
};

export default function MoqPublish({ params }: { params: URLSearchParams }) {
  // The graph owns capture devices, so it is created in an effect: under StrictMode a
  // state initializer would build one that the first cleanup closes for good.
  const [publisher, setPublisher] = useState<Publisher | null>(null);
  useEffect(() => {
    const p = new Publisher();
    // The state update is the point of this effect: React has to re-render with the graph.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPublisher(p);
    return () => {
      setPublisher(null);
      p.close();
    };
  }, []);

  if (!publisher) return null;
  return <PublishForm publisher={publisher} params={params} />;
}

function PublishForm({ publisher, params }: { publisher: Publisher; params: URLSearchParams }) {
  // ---- Connection (same query params and history as the MoQ Streamer) -----
  const [serverUrl, setServerUrl] = useSessionInput("moq:url", params, "url");
  const [token, setToken] = useSessionInput("moq:token", params, "token");
  const [broadcastPath, setBroadcastPath] = useSessionInput("moq:path", params, "path");
  const [certHash, setCertHash] = useSessionInput("moq:cert", params, "cert");
  const [wsFallback, setWsFallback] = useState(false);

  // ---- Broadcast ----------------------------------------------------------
  const [announce, setAnnounce] = useState<AnnounceMode>("catalog");
  const [flip, setFlip] = useState(false);
  const [latencyMax, setLatencyMax] = useState("");

  // ---- Source -------------------------------------------------------------
  const [source, setSource] = useState<SourceOption>(NONE);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [preview, setPreview] = useState<Publish.Preview.Mode>("source");

  // ---- Camera / microphone capture ----------------------------------------
  const [cameraDevice, setCameraDevice] = useState("");
  const [captureResolution, setCaptureResolution] = useState("auto");
  const [captureFramerate, setCaptureFramerate] = useState("auto");
  const [facingMode, setFacingMode] = useState<FacingMode>("auto");
  const [micDevice, setMicDevice] = useState("");
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [autoGainControl, setAutoGainControl] = useState(true);

  // ---- Video encoder ------------------------------------------------------
  const [videoCodec, setVideoCodec] = useState("auto");
  const [maxPixels, setMaxPixels] = useState("auto");
  const [maxScale, setMaxScale] = useState("");
  const [encodeFramerate, setEncodeFramerate] = useState("auto");
  const [maxBitrate, setMaxBitrate] = useState("auto");
  const [bitrateScale, setBitrateScale] = useState("");
  const [keyframeInterval, setKeyframeInterval] = useState("");

  // ---- Audio encoder ------------------------------------------------------
  const [audioCodec, setAudioCodec] = useState<AudioCodecKind>("opus");
  const [audioBitrate, setAudioBitrate] = useState("auto");
  const [opusFrameDuration, setOpusFrameDuration] = useState("auto");
  const [opusComplexity, setOpusComplexity] = useState("");
  const [opusPacketLoss, setOpusPacketLoss] = useState("");
  const [opusFec, setOpusFec] = useState(false);
  const [opusDtx, setOpusDtx] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState("1");
  const [sampleRate, setSampleRate] = useState("auto");
  const [channelCount, setChannelCount] = useState("auto");

  // ---- Push form state into the package's live signals --------------------
  useEffect(() => {
    publisher.source.set(source === NONE ? undefined : source);
  }, [publisher, source]);
  useEffect(() => publisher.videoEnabled.set(videoEnabled), [publisher, videoEnabled]);
  useEffect(() => publisher.audioEnabled.set(audioEnabled), [publisher, audioEnabled]);
  useEffect(() => publisher.preview.set(preview), [publisher, preview]);
  useEffect(() => publisher.announce.set(announce), [publisher, announce]);
  useEffect(() => publisher.flip.set(flip), [publisher, flip]);
  useEffect(() => publisher.latencyMax.set(optionalNumber(latencyMax)), [publisher, latencyMax]);
  useEffect(() => {
    publisher.name.set(Net.Path.from(broadcastPath.trim() || DEFAULT_BROADCAST_PATH));
  }, [publisher, broadcastPath]);

  useEffect(() => {
    publisher.camera.device.preferred.set(cameraDevice || undefined);
  }, [publisher, cameraDevice]);
  useEffect(() => {
    const res = CAPTURE_RESOLUTIONS[captureResolution];
    const fps = FRAMERATES[captureFramerate]?.fps;
    const constraints: Publish.Video.Constraints = {};
    if (res?.width && res.height) {
      constraints.width = { ideal: res.width };
      constraints.height = { ideal: res.height };
    }
    if (fps) constraints.frameRate = { ideal: fps };
    if (facingMode !== "auto") constraints.facingMode = facingMode;
    publisher.camera.constraints.set(constraints);
  }, [publisher, captureResolution, captureFramerate, facingMode]);

  useEffect(() => {
    publisher.microphone.device.preferred.set(micDevice || undefined);
  }, [publisher, micDevice]);
  useEffect(() => {
    publisher.microphone.constraints.set({ echoCancellation, noiseSuppression, autoGainControl });
  }, [publisher, echoCancellation, noiseSuppression, autoGainControl]);

  useEffect(() => {
    const config: Publish.Video.Config = {
      codec: VIDEO_CODECS[videoCodec]?.codec,
      maxPixels: MAX_PIXELS[maxPixels]?.pixels,
      maxScale: optionalNumber(maxScale),
      frameRate: FRAMERATES[encodeFramerate]?.fps,
      maxBitrate: VIDEO_BITRATES[maxBitrate]?.bps,
      bitrateScale: optionalNumber(bitrateScale),
    };
    const keyframeMs = optionalNumber(keyframeInterval);
    if (keyframeMs !== undefined && keyframeMs > 0)
      config.keyframeInterval = Net.Time.Milli(keyframeMs);
    publisher.video.config.set(config);
  }, [
    publisher,
    videoCodec,
    maxPixels,
    maxScale,
    encodeFramerate,
    maxBitrate,
    bitrateScale,
    keyframeInterval,
  ]);

  useEffect(() => {
    const bitrate = AUDIO_BITRATES[audioBitrate]?.bps;
    if (audioCodec === "aac") {
      publisher.audio.codec.set({ mime: "aac", bitrate });
      return;
    }
    const frameMs = OPUS_FRAME_DURATIONS[opusFrameDuration]?.ms;
    const codec: Publish.Audio.OpusConfig = {
      mime: "opus",
      bitrate,
      frameDuration: frameMs !== undefined ? Net.Time.Milli(frameMs) : undefined,
      complexity: optionalNumber(opusComplexity),
      packetlossperc: optionalNumber(opusPacketLoss),
      useinbandfec: opusFec,
      usedtx: opusDtx,
    };
    publisher.audio.codec.set(codec);
  }, [
    publisher,
    audioCodec,
    audioBitrate,
    opusFrameDuration,
    opusComplexity,
    opusPacketLoss,
    opusFec,
    opusDtx,
  ]);
  useEffect(() => publisher.audio.muted.set(muted), [publisher, muted]);
  useEffect(() => publisher.audio.volume.set(optionalNumber(volume) ?? 1), [publisher, volume]);
  useEffect(() => {
    publisher.audio.sampleRate.set(SAMPLE_RATES[sampleRate]?.hz);
  }, [publisher, sampleRate]);
  useEffect(() => {
    publisher.audio.channelCount.set(CHANNEL_COUNTS[channelCount]?.channels);
  }, [publisher, channelCount]);

  // ---- Read the package's state -------------------------------------------
  const running = useValue(publisher.running);
  const status = useValue(publisher.status);
  const error = useValue(publisher.error);
  const announced = useValue(publisher.broadcast.net) !== undefined;
  const cameras = useValue(publisher.camera.device.out.available) ?? [];
  const microphones = useValue(publisher.microphone.device.out.available) ?? [];
  const fileName = useValue(publisher.file.file)?.name;
  const hasVideo = useValue(publisher.videoSource) !== undefined;
  const hasAudio = useValue(publisher.audioSource) !== undefined;

  const start = () => {
    saveToHistory("moq:url", serverUrl);
    if (token) saveToHistory("moq:token", token);
    if (certHash) saveToHistory("moq:cert", certHash);
    if (broadcastPath.trim()) saveToHistory("moq:path", broadcastPath.trim());
    try {
      publisher.start({ url: serverUrl, token, certHash, wsFallback });
    } catch (err) {
      publisher.error.set(err instanceof Error ? err.message : String(err));
    }
  };

  const connectionLocked = running;

  return (
    <div
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "auto" }}
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
          historyKey="moq:url"
          value={serverUrl}
          onChange={setServerUrl}
          placeholder="https://relay.example.com/anon"
          label="Relay URL"
        />
        <SuggestInput
          historyKey="moq:path"
          value={broadcastPath}
          onChange={setBroadcastPath}
          placeholder={DEFAULT_BROADCAST_PATH}
          label="Broadcast path"
        />
        <SuggestInput
          historyKey="moq:token"
          value={token}
          onChange={setToken}
          placeholder="Optional auth token"
          label="Token"
        />
        <SuggestInput
          historyKey="moq:cert"
          value={certHash}
          onChange={setCertHash}
          placeholder="Self-signed cert SHA-256 hex (testing only)"
          label="Cert hash"
        />
      </div>

      <div style={groupRowStyle}>
        <OptionGroup label="Connection">
          <Checkbox
            label="WebSocket fallback"
            checked={wsFallback}
            onChange={setWsFallback}
            disabled={connectionLocked}
          />
          <Select
            label="Announce"
            value={announce}
            options={ANNOUNCE_MODES}
            onChange={setAnnounce}
          />
          <NumberField
            label="Relay retention (ms)"
            value={latencyMax}
            onChange={setLatencyMax}
            placeholder="default"
          />
          <Checkbox label="Flip horizontally" checked={flip} onChange={setFlip} />
        </OptionGroup>

        <OptionGroup label="Source">
          <Select label="Source" value={source} options={SOURCES} onChange={setSource} />
          {source === "file" && (
            <div style={fieldStyle}>
              <span style={labelStyle}>File</span>
              <button onClick={() => publisher.file.prompt()} style={buttonStyle}>
                {fileName ? `Change (${fileName})` : "Choose file…"}
              </button>
            </div>
          )}
          <Checkbox label="Video" checked={videoEnabled} onChange={setVideoEnabled} />
          <Checkbox label="Audio" checked={audioEnabled} onChange={setAudioEnabled} />
          <Select label="Preview" value={preview} options={PREVIEW_MODES} onChange={setPreview} />
        </OptionGroup>
      </div>

      {source === "camera" && (
        <div style={groupRowStyle}>
          <OptionGroup label="Camera capture">
            <Select
              label="Device"
              value={cameraDevice}
              options={deviceOptions(cameras)}
              onChange={setCameraDevice}
            />
            <Select
              label="Resolution"
              value={captureResolution}
              options={selectOptions(CAPTURE_RESOLUTIONS)}
              onChange={setCaptureResolution}
            />
            <Select
              label="Frame rate"
              value={captureFramerate}
              options={selectOptions(FRAMERATES)}
              onChange={setCaptureFramerate}
            />
            <Select
              label="Facing"
              value={facingMode}
              options={FACING_MODES}
              onChange={setFacingMode}
            />
          </OptionGroup>
          <OptionGroup label="Microphone capture">
            <Select
              label="Device"
              value={micDevice}
              options={deviceOptions(microphones)}
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
        </div>
      )}

      <div style={groupRowStyle}>
        <OptionGroup label="Video encoder">
          <Select
            label="Codec"
            value={videoCodec}
            options={selectOptions(VIDEO_CODECS)}
            onChange={setVideoCodec}
          />
          <Select
            label="Max resolution"
            value={maxPixels}
            options={selectOptions(MAX_PIXELS)}
            onChange={setMaxPixels}
          />
          <NumberField
            label="Max scale"
            value={maxScale}
            onChange={setMaxScale}
            placeholder="e.g. 0.5"
          />
          <Select
            label="Frame rate"
            value={encodeFramerate}
            options={selectOptions(FRAMERATES)}
            onChange={setEncodeFramerate}
          />
          <Select
            label="Max bitrate"
            value={maxBitrate}
            options={selectOptions(VIDEO_BITRATES)}
            onChange={setMaxBitrate}
          />
          <NumberField
            label="Bitrate scale"
            value={bitrateScale}
            onChange={setBitrateScale}
            placeholder="default 0.07"
          />
          <NumberField
            label="Keyframe interval (ms)"
            value={keyframeInterval}
            onChange={setKeyframeInterval}
            placeholder="default 2000"
          />
        </OptionGroup>

        <OptionGroup label="Audio encoder">
          <Select
            label="Codec"
            value={audioCodec}
            options={AUDIO_CODECS}
            onChange={setAudioCodec}
          />
          <Select
            label="Bitrate"
            value={audioBitrate}
            options={selectOptions(AUDIO_BITRATES)}
            onChange={setAudioBitrate}
          />
          {audioCodec === "opus" && (
            <>
              <Select
                label="Frame duration"
                value={opusFrameDuration}
                options={selectOptions(OPUS_FRAME_DURATIONS)}
                onChange={setOpusFrameDuration}
              />
              <NumberField
                label="Complexity (0-10)"
                value={opusComplexity}
                onChange={setOpusComplexity}
                placeholder="default"
              />
              <NumberField
                label="Expected packet loss (%)"
                value={opusPacketLoss}
                onChange={setOpusPacketLoss}
                placeholder="default"
              />
              <Checkbox label="In-band FEC" checked={opusFec} onChange={setOpusFec} />
              <Checkbox label="DTX" checked={opusDtx} onChange={setOpusDtx} />
            </>
          )}
          <Select
            label="Sample rate"
            value={sampleRate}
            options={selectOptions(SAMPLE_RATES)}
            onChange={setSampleRate}
          />
          <Select
            label="Channels"
            value={channelCount}
            options={selectOptions(CHANNEL_COUNTS)}
            onChange={setChannelCount}
          />
          <NumberField
            label="Volume (1 = unity)"
            value={volume}
            onChange={setVolume}
            placeholder="1"
          />
          <Checkbox label="Muted" checked={muted} onChange={setMuted} />
        </OptionGroup>
      </div>

      <div
        style={{
          display: "flex",
          gap: "1rem",
          alignItems: "center",
          marginBottom: "0.5rem",
          flexShrink: 0,
        }}
      >
        {!running ? (
          <button
            onClick={start}
            style={{ padding: "0.5rem 1.5rem", fontSize: "1rem", cursor: "pointer" }}
          >
            Start
          </button>
        ) : (
          <button
            onClick={() => publisher.stop()}
            style={{ padding: "0.5rem 1.5rem", fontSize: "1rem", cursor: "pointer" }}
          >
            Stop
          </button>
        )}
        <StatusLine
          running={running}
          status={status}
          announced={announced}
          error={error}
          hasVideo={hasVideo}
          hasAudio={hasAudio}
        />
      </div>

      <StatsLine publisher={publisher} />

      <div
        style={{
          flex: 1,
          minHeight: 240,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <canvas
          ref={(el) => publisher.canvas.set(el ?? undefined)}
          style={{ maxWidth: "100%", maxHeight: "100%", background: "#000" }}
        />
      </div>
    </div>
  );
}

function deviceOptions(devices: MediaDeviceInfo[]): { value: string; label: string }[] {
  return [
    { value: "", label: "Default" },
    ...devices
      .filter((d) => d.deviceId)
      .map((d) => ({ value: d.deviceId, label: d.label || `Device ${d.deviceId.slice(0, 8)}` })),
  ];
}

function StatusLine({
  running,
  status,
  announced,
  error,
  hasVideo,
  hasAudio,
}: {
  running: boolean;
  status: Publish.Net.Connection.ReloadStatus;
  announced: boolean;
  error: string | undefined;
  hasVideo: boolean;
  hasAudio: boolean;
}) {
  let text: string;
  let color = "var(--text-muted)";
  if (error) {
    text = `Error: ${error}`;
    color = "var(--error)";
  } else if (!running) {
    text = "Stopped";
  } else if (status !== "connected") {
    text = status === "connecting" ? "Connecting…" : "Disconnected, reconnecting…";
  } else if (announced) {
    text = "Publishing";
    color = "var(--accent)";
  } else {
    text = "Connected, waiting for a source";
  }

  const tracks = [hasVideo && "video", hasAudio && "audio"].filter(Boolean).join(" + ");
  return (
    <span style={{ fontSize: "0.9rem", fontWeight: 500, color }}>
      {text}
      {tracks && (
        <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> · capturing {tracks}</span>
      )}
    </span>
  );
}

interface Rates {
  /** Frames the browser's capture track delivered; screen capture only delivers on change. */
  captureFps: number;
  videoFps: number;
  videoBps: number;
  audioBps: number;
}

/** Encoder output rates from the package's cumulative stats, sampled once a second. */
function StatsLine({ publisher }: { publisher: Publisher }) {
  const resolved = useValue(publisher.video.out.resolved);
  const videoActive = useValue(publisher.video.out.active);
  const audioCatalog = useValue(publisher.audio.out.catalog);
  const probe = useValue(publisher.probe);
  const hasVideo = useValue(publisher.videoSource) !== undefined;
  const [rates, setRates] = useState<Rates | null>(null);

  useEffect(() => {
    let captured = 0;
    const unsubscribe = publisher.capture.out.frame.subscribe((frame) => {
      if (frame) captured++;
    });
    let prev = { video: publisher.video.out.stats.peek(), audio: publisher.audio.out.stats.peek() };
    let prevAt = performance.now();
    const id = setInterval(() => {
      const video = publisher.video.out.stats.peek();
      const audio = publisher.audio.out.stats.peek();
      const now = performance.now();
      const secs = (now - prevAt) / 1000;
      setRates({
        captureFps: captured / secs,
        videoFps: (video.frames - prev.video.frames) / secs,
        videoBps: ((video.bytes - prev.video.bytes) * 8) / secs,
        audioBps: ((audio.bytes - prev.audio.bytes) * 8) / secs,
      });
      captured = 0;
      prev = { video, audio };
      prevAt = now;
    }, 1000);
    return () => {
      clearInterval(id);
      unsubscribe();
    };
  }, [publisher]);

  const parts: string[] = [];
  if (hasVideo && rates) parts.push(`Capture: ${rates.captureFps.toFixed(0)} fps`);
  if (resolved) {
    parts.push(
      `Video: ${resolved.codec} ${resolved.width}×${resolved.height}` +
        (resolved.bitrate ? ` @ ${formatBitrate(resolved.bitrate)} target` : "") +
        (videoActive
          ? rates
            ? `, encoding ${rates.videoFps.toFixed(0)} fps, ${formatBitrate(rates.videoBps)}`
            : ""
          : ", encoder idle (no subscriber)"),
    );
  } else if (hasVideo) {
    parts.push("Video: waiting for the first frame");
  }
  if (audioCatalog) {
    parts.push(
      `Audio: ${audioCatalog.codec} ${audioCatalog.sampleRate / 1000} kHz ${audioCatalog.numberOfChannels}ch` +
        (rates ? `, ${formatBitrate(rates.audioBps)}` : ""),
    );
  }
  if (probe?.rtt !== undefined) parts.push(`RTT ${probe.rtt.toFixed(0)} ms`);
  if (probe?.estimatedRecvRate !== undefined) {
    parts.push(`Peer receiving ${formatBitrate(probe.estimatedRecvRate)}`);
  }
  if (parts.length === 0) return null;

  return (
    <div
      style={{
        fontSize: "0.85rem",
        color: "var(--text-muted)",
        marginBottom: "0.5rem",
        flexShrink: 0,
      }}
    >
      {parts.join("  ·  ")}
    </div>
  );
}
