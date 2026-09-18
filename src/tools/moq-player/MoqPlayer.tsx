import { useEffect, useState } from "react";
import { useValue } from "@moq/signals/react";
import * as Watch from "@moq/watch";
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
} from "../../ui/form.tsx";
import { formatBitrate } from "../../ui/format.ts";
import { Player, type Latency } from "./player.ts";
import type { ToolMeta } from "../registry.ts";

const Net = Watch.Net;

// Path the broadcast is consumed from when the field is left empty. Matches the
// publishers' default.
const DEFAULT_BROADCAST_PATH = "test";

type LatencyMode = "real-time" | "instant" | "fixed" | "range";
const LATENCY_MODES: { value: LatencyMode; label: string }[] = [
  { value: "real-time", label: "Real-time (adapts to RTT)" },
  { value: "fixed", label: "Fixed jitter buffer" },
  { value: "range", label: "Range (buffered playback)" },
  { value: "instant", label: "Instant (paint on decode, no audio)" },
];

const CATALOG_FORMATS: { value: string; label: string }[] = [
  { value: "auto", label: "Auto (from name suffix)" },
  ...Watch.CATALOG_FORMATS.filter((f) => f !== "manual").map((f) => ({ value: f, label: f })),
];

const AUTO = "auto";

function bound(raw: string): Watch.Bound {
  const ms = optionalNumber(raw);
  return ms === undefined ? "real-time" : Net.Time.Milli(ms);
}

export const meta: ToolMeta = {
  id: "moq-player",
  name: "MoQ Player",
  description: "Play a MoQ broadcast from a relay with the @moq/watch library",
  scrollable: false,
};

export default function MoqPlayer({ params }: { params: URLSearchParams }) {
  // The graph owns decoders and an AudioContext, so it is created in an effect: under
  // StrictMode a state initializer would build one that the first cleanup closes for good.
  const [player, setPlayer] = useState<Player | null>(null);
  useEffect(() => {
    const p = new Player();
    // The state update is the point of this effect: React has to re-render with the graph.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlayer(p);
    return () => {
      setPlayer(null);
      p.close();
    };
  }, []);

  if (!player) return null;
  return <PlayerForm player={player} params={params} />;
}

function PlayerForm({ player, params }: { player: Player; params: URLSearchParams }) {
  // The relay, path and cert fields share their storage keys with the MoQ publishers, so a
  // publish-in-one-tab / play-in-another loop only needs them typed once. The JWT is a
  // different credential from the publishers' bearer token, so it gets its own key.
  const [serverUrl, setServerUrl] = useSessionInput("moq:url", params, "url");
  const [broadcastPath, setBroadcastPath] = useSessionInput("moq:path", params, "path");
  const [jwt, setJwt] = useSessionInput("moq:jwt", params, "jwt");
  const [certHash, setCertHash] = useSessionInput("moq:cert", params, "cert");
  const [wsFallback, setWsFallback] = useState(false);
  const [waitForAnnounce, setWaitForAnnounce] = useState(true);
  const [catalogFormat, setCatalogFormat] = useState(AUTO);

  // ---- Playback -----------------------------------------------------------
  const [latencyMode, setLatencyMode] = useState<LatencyMode>("real-time");
  const [latencyMs, setLatencyMs] = useState("100");
  const [latencyMin, setLatencyMin] = useState("");
  const [latencyMax, setLatencyMax] = useState("");
  const [rendition, setRendition] = useState(AUTO);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.5);

  // ---- Push form state into the package's live signals --------------------
  useEffect(() => {
    player.name.set(Net.Path.from(broadcastPath.trim() || DEFAULT_BROADCAST_PATH));
  }, [player, broadcastPath]);
  useEffect(() => player.reload.set(waitForAnnounce), [player, waitForAnnounce]);
  useEffect(() => {
    player.catalogFormat.set(
      catalogFormat === AUTO ? undefined : Watch.parseCatalogFormat(catalogFormat),
    );
  }, [player, catalogFormat]);
  useEffect(() => {
    let latency: Latency;
    switch (latencyMode) {
      case "instant":
        latency = "instant";
        break;
      case "fixed":
        latency = bound(latencyMs);
        break;
      case "range":
        latency = Watch.latencyFromBounds(bound(latencyMin), bound(latencyMax));
        break;
      default:
        latency = "real-time";
    }
    player.latency.set(latency);
  }, [player, latencyMode, latencyMs, latencyMin, latencyMax]);
  useEffect(() => {
    player.target.set(rendition === AUTO ? undefined : { name: rendition });
  }, [player, rendition]);
  useEffect(() => player.paused.set(paused), [player, paused]);
  useEffect(() => player.muted.set(muted), [player, muted]);
  useEffect(() => player.volume.set(volume), [player, volume]);

  // ---- Read the package's state -------------------------------------------
  const running = useValue(player.running);
  const status = useValue(player.status);
  const error = useValue(player.error);
  const broadcastStatus = useValue(player.broadcast.out.status);
  const renditions = useValue(player.video.source.out.available);
  const videoError = useValue(player.video.source.out.error);
  const videoTrack = useValue(player.video.source.out.track);
  const audioTrack = useValue(player.audio.source.out.track);

  const start = () => {
    saveToHistory("moq:url", serverUrl);
    if (jwt) saveToHistory("moq:jwt", jwt);
    if (certHash) saveToHistory("moq:cert", certHash);
    if (broadcastPath.trim()) saveToHistory("moq:path", broadcastPath.trim());
    try {
      player.start({ url: serverUrl, token: jwt, certHash, wsFallback });
    } catch (err) {
      player.error.set(err instanceof Error ? err.message : String(err));
    }
  };

  const renditionOptions = [
    { value: AUTO, label: "Auto (fit canvas)" },
    ...Object.entries(renditions).map(([name, config]) => ({
      value: name,
      label: `${name} (${videoLabel(config)})`,
    })),
  ];

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
          historyKey="moq:jwt"
          value={jwt}
          onChange={setJwt}
          placeholder="Optional JWT"
          label="JWT"
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
            disabled={running}
          />
          <Checkbox
            label="Wait for announcement"
            checked={waitForAnnounce}
            onChange={setWaitForAnnounce}
          />
          <Select
            label="Catalog format"
            value={catalogFormat}
            options={CATALOG_FORMATS}
            onChange={setCatalogFormat}
          />
        </OptionGroup>

        <OptionGroup label="Playback">
          <Select
            label="Latency"
            value={latencyMode}
            options={LATENCY_MODES}
            onChange={setLatencyMode}
          />
          {latencyMode === "fixed" && (
            <NumberField
              label="Jitter buffer (ms)"
              value={latencyMs}
              onChange={setLatencyMs}
              placeholder="real-time"
            />
          )}
          {latencyMode === "range" && (
            <>
              <NumberField
                label="Min (ms)"
                value={latencyMin}
                onChange={setLatencyMin}
                placeholder="real-time"
              />
              <NumberField
                label="Max (ms)"
                value={latencyMax}
                onChange={setLatencyMax}
                placeholder="real-time"
              />
            </>
          )}
          <Select
            label="Video rendition"
            value={rendition}
            options={renditionOptions}
            onChange={setRendition}
          />
          <div style={fieldStyle}>
            <label style={labelStyle}>Volume ({Math.round(volume * 100)}%)</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>
          <Checkbox label="Muted" checked={muted} onChange={setMuted} />
          <Checkbox label="Paused" checked={paused} onChange={setPaused} />
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
            onClick={() => player.stop()}
            style={{ padding: "0.5rem 1.5rem", fontSize: "1rem", cursor: "pointer" }}
          >
            Stop
          </button>
        )}
        {latencyMode === "range" && (
          <button onClick={() => player.reset()} style={buttonStyle} disabled={!running}>
            Reset clock
          </button>
        )}
        <StatusLine
          running={running}
          status={status}
          broadcast={broadcastStatus}
          error={error}
          videoError={videoError}
          hasVideo={videoTrack !== undefined}
          hasAudio={audioTrack !== undefined}
        />
      </div>

      <StatsLine player={player} />

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
          ref={(el) => player.canvas.set(el ?? undefined)}
          style={{ maxWidth: "100%", maxHeight: "100%", background: "#000" }}
        />
      </div>
    </div>
  );
}

function StatusLine({
  running,
  status,
  broadcast,
  error,
  videoError,
  hasVideo,
  hasAudio,
}: {
  running: boolean;
  status: Watch.Net.Connection.ReloadStatus;
  broadcast: "offline" | "loading" | "live";
  error: string | undefined;
  videoError: Watch.Video.SourceError | undefined;
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
  } else if (broadcast === "live") {
    text = "Playing";
    color = "var(--accent)";
  } else if (broadcast === "loading") {
    text = "Connected, fetching the catalog…";
  } else {
    text = "Connected, waiting for the broadcast";
  }

  const tracks = [hasVideo && "video", hasAudio && "audio"].filter(Boolean).join(" + ");
  return (
    <span style={{ fontSize: "0.9rem", fontWeight: 500, color }}>
      {text}
      {tracks && (
        <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> · playing {tracks}</span>
      )}
      {videoError === "unsupported" && (
        <span style={{ color: "var(--error)", fontWeight: 400 }}>
          {" "}
          · no video rendition this browser can decode
        </span>
      )}
    </span>
  );
}

interface Rates {
  videoFps: number;
  videoBps: number;
  audioBps: number;
}

/** Decoder input rates from the package's cumulative stats, sampled once a second. */
function StatsLine({ player }: { player: Player }) {
  const videoConfig = useValue(player.video.source.out.config);
  const audioConfig = useValue(player.audio.source.out.config);
  const display = useValue(player.video.out.display);
  const videoStalled = useValue(player.video.out.stalled);
  const audioStalled = useValue(player.audio.out.stalled);
  const buffer = useValue(player.sync.out.buffer);
  const jitter = useValue(player.sync.out.jitter);
  const probe = useValue(player.probe);
  const [rates, setRates] = useState<Rates | null>(null);

  useEffect(() => {
    let prev = { video: player.video.out.stats.peek(), audio: player.audio.out.stats.peek() };
    let prevAt = performance.now();
    const id = setInterval(() => {
      const video = player.video.out.stats.peek();
      const audio = player.audio.out.stats.peek();
      const now = performance.now();
      const secs = (now - prevAt) / 1000;
      // The stats reset to undefined when a track is (re)subscribed, so a missing sample on
      // either side of the window counts as zero rather than a negative delta.
      const delta = (a: number | undefined, b: number | undefined) =>
        a !== undefined && b !== undefined && a >= b ? a - b : (a ?? 0);
      setRates({
        videoFps: delta(video?.frameCount, prev.video?.frameCount) / secs,
        videoBps: (delta(video?.bytesReceived, prev.video?.bytesReceived) * 8) / secs,
        audioBps: (delta(audio?.bytesReceived, prev.audio?.bytesReceived) * 8) / secs,
      });
      prev = { video, audio };
      prevAt = now;
    }, 1000);
    return () => clearInterval(id);
  }, [player]);

  const parts: string[] = [];
  if (videoConfig) {
    const size = display ? ` ${display.width}×${display.height}` : "";
    parts.push(
      `Video: ${videoConfig.codec}${size}` +
        (rates ? `, ${rates.videoFps.toFixed(0)} fps, ${formatBitrate(rates.videoBps)}` : "") +
        (videoStalled ? ", stalled" : ""),
    );
  }
  if (audioConfig) {
    parts.push(
      `Audio: ${audioConfig.codec} ${audioConfig.sampleRate / 1000} kHz ${audioConfig.numberOfChannels}ch` +
        (rates ? `, ${formatBitrate(rates.audioBps)}` : "") +
        (audioStalled ? ", stalled" : ""),
    );
  }
  if (videoConfig || audioConfig) {
    parts.push(`Buffer ${buffer.toFixed(0)} ms (jitter ${jitter.toFixed(0)} ms)`);
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

function videoLabel(config: Watch.Hang.Catalog.VideoConfig): string {
  const size =
    config.codedWidth && config.codedHeight ? ` ${config.codedWidth}×${config.codedHeight}` : "";
  const bitrate = config.bitrate ? ` @ ${formatBitrate(config.bitrate)}` : "";
  return `${config.codec}${size}${bitrate}`;
}
