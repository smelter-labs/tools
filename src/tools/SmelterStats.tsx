import { useState, useEffect, useRef, useCallback } from "react";
import { useSessionInput } from "../useSessionInput.ts";
import SuggestInput, { saveToHistory } from "../SuggestInput.tsx";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ── Types matching the /stats API response ──────────────────────────

interface TrackBitrate {
  bitrate_1_second: number;
  bitrate_1_minute: number;
}

interface RtpSlidingWindowBufferStats {
  packets_lost: number;
  packets_received: number;
  effective_buffer_on_write_avg_seconds: number;
  effective_buffer_on_write_max_seconds: number;
  effective_buffer_on_write_min_seconds: number;
  effective_buffer_on_pop_avg_seconds: number;
  effective_buffer_on_pop_max_seconds: number;
  effective_buffer_on_pop_min_seconds: number;
  input_buffer_avg_seconds: number;
  input_buffer_max_seconds: number;
  input_buffer_min_seconds: number;
}

interface RtpTrack extends TrackBitrate {
  packets_lost: number;
  packets_received: number;
  last_10_seconds: RtpSlidingWindowBufferStats;
}

type SimpleSyncTrackState = "initial_buffering" | "running";

/** Non-live stream, timestamps are normalized to start at zero. */
interface SimpleSyncTrack extends TrackBitrate {
  mode: "simple";
  /** State of the synchronization. */
  state: SimpleSyncTrackState;
}

type LiveSyncTrackState = "waiting_for_start" | "started_shared" | "started_track";

interface LiveSyncSlidingWindowStats {
  discontinuities_detected: number;
  /** Measured when chunk enters the sync buffer. Not measured before the track starts. */
  effective_buffer_on_receive_avg_seconds: number;
  effective_buffer_on_receive_max_seconds: number;
  effective_buffer_on_receive_min_seconds: number;
  /** Measured when chunk leaves the sync buffer. */
  effective_buffer_on_output_avg_seconds: number;
  effective_buffer_on_output_max_seconds: number;
  effective_buffer_on_output_min_seconds: number;
}

type LiveSyncBuffer = { type: "fifo"; duration_seconds: number };

/**
 * Duration of the content held by the sync buffer for the chart, or `null` when it should not be
 * plotted. FIFO buffers are shown only as text in the card, not on the graph.
 */
function chartedSyncBufferSeconds(b: LiveSyncBuffer): number | null {
  switch (b.type) {
    case "fifo":
      return null;
  }
}

/** Live stream, synchronized to the estimated live edge. */
interface LiveSyncTrack extends TrackBitrate {
  mode: "live";
  state: LiveSyncTrackState;
  discontinuities_detected: number;
  /**
   * Remaining shift of the playback position to reach the target buffer.
   * Positive when the buffer is being shrunk, negative when grown, zero when converged.
   */
  target_offset_distance_seconds: number;
  /**
   * How far the playback position is behind the pessimistic live edge estimate (content arriving
   * as slow as the slowest recent chunk). Margin before playback runs out of content.
   * `null` before the track starts.
   */
  live_edge_lower_bound_distance_seconds?: number | null;
  /**
   * How far the playback position is behind the optimistic live edge estimate (content arriving
   * as fast as the fastest recent chunk). Total latency introduced by the synchronization.
   * `null` before the track starts.
   */
  live_edge_upper_bound_distance_seconds?: number | null;
  buffer: LiveSyncBuffer;
  last_10_seconds: LiveSyncSlidingWindowStats;
}

/** Track synchronized by the input sync (`RTMP`, `HLS`). `null` until the track is registered. */
type InputSyncTrack = SimpleSyncTrack | LiveSyncTrack;

interface StatsReport {
  inputs: Record<string, InputStatsReport>;
  outputs: Record<string, OutputStatsReport>;
}

type InputStatsReport =
  | { type: "rtp" | "whip" | "whep"; video_rtp: RtpTrack; audio_rtp: RtpTrack }
  | { type: "hls"; video?: InputSyncTrack | null; audio?: InputSyncTrack | null }
  | {
      type: "rtmp";
      is_connected: boolean;
      video?: InputSyncTrack | null;
      audio?: InputSyncTrack | null;
    }
  | { type: "mp4" | "moq_server" | "moq_client"; video: TrackBitrate; audio: TrackBitrate };

type OutputStatsReport =
  | { type: "whep"; video: TrackBitrate; audio: TrackBitrate; connected_peers: number }
  | { type: "whip"; video: TrackBitrate; audio: TrackBitrate; is_connected: boolean }
  | {
      type: "hls" | "mp4" | "rtmp" | "rtp" | "moq_client";
      video: TrackBitrate;
      audio: TrackBitrate;
    };

// ── Helpers ─────────────────────────────────────────────────────────

interface Tracks {
  video: TrackBitrate | null;
  audio: TrackBitrate | null;
}

function getInputTracks(r: InputStatsReport): Tracks {
  switch (r.type) {
    case "rtp":
    case "whip":
    case "whep":
      return { video: r.video_rtp, audio: r.audio_rtp };
    case "hls":
    case "rtmp":
      return { video: r.video ?? null, audio: r.audio ?? null };
    case "mp4":
    case "moq_server":
    case "moq_client":
      return { video: r.video, audio: r.audio };
  }
}

function getOutputTracks(r: OutputStatsReport): Tracks {
  return { video: r.video, audio: r.audio };
}

function formatBitrate(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} kbps`;
  return `${bps} bps`;
}

function formatTrackBitrate(t: TrackBitrate | null): string {
  return t ? formatBitrate(t.bitrate_1_minute) : "—";
}

function formatSeconds(s: number): string {
  return `${(s * 1000).toFixed(0)} ms`;
}

function formatOptionalSeconds(s: number | null | undefined): string {
  return s == null ? "n/a" : formatSeconds(s);
}

/** One row of per-track details; values render in fixed-width cells so digit changes don't shift text. */
interface TrackInfo {
  label: string;
  fields: { name: string; value: string }[];
}

function rtpTrackInfo(label: string, t: RtpTrack): TrackInfo {
  const w = t.last_10_seconds;
  return {
    label,
    fields: [
      { name: "pkts", value: String(t.packets_received) },
      { name: "lost", value: String(t.packets_lost) },
      { name: "pkts (10s)", value: String(w.packets_received) },
      { name: "lost (10s)", value: String(w.packets_lost) },
    ],
  };
}

function syncTrackInfo(label: string, t: InputSyncTrack | null | undefined): TrackInfo {
  if (!t) return { label, fields: [{ name: "mode", value: "not registered" }] };
  if (t.mode === "simple") {
    return {
      label,
      fields: [
        { name: "mode", value: "simple" },
        { name: "state", value: t.state },
      ],
    };
  }
  return {
    label,
    fields: [
      { name: "mode", value: "live" },
      { name: "state", value: t.state },
      { name: "sync buffer", value: formatSeconds(t.buffer.duration_seconds) },
      { name: "target offset", value: formatSeconds(t.target_offset_distance_seconds) },
      {
        name: "live edge (lower)",
        value: formatOptionalSeconds(t.live_edge_lower_bound_distance_seconds),
      },
      {
        name: "live edge (upper)",
        value: formatOptionalSeconds(t.live_edge_upper_bound_distance_seconds),
      },
      { name: "discont.", value: String(t.discontinuities_detected) },
      { name: "discont. (10s)", value: String(t.last_10_seconds.discontinuities_detected) },
    ],
  };
}

function inputTrackInfo(r: InputStatsReport): TrackInfo[] {
  switch (r.type) {
    case "rtp":
    case "whip":
    case "whep":
      return [rtpTrackInfo("Video", r.video_rtp), rtpTrackInfo("Audio", r.audio_rtp)];
    case "hls":
    case "rtmp":
      return [syncTrackInfo("Video", r.video), syncTrackInfo("Audio", r.audio)];
    default:
      return [];
  }
}

function TrackInfoTable({ rows }: { rows: TrackInfo[] }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ margin: "0.25rem 0 0.5rem" }}>
      {rows.map((row) => (
        <div key={row.label} style={trackRowStyle}>
          <div style={trackLabelStyle}>{row.label}</div>
          <div style={trackFieldGridStyle}>
            {row.fields.map((f) => (
              <div key={f.name} style={trackFieldStyle}>
                <span style={{ color: "var(--text-muted)" }}>{f.name}</span>
                <span style={trackValueStyle}>{f.value}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function outputExtraInfo(r: OutputStatsReport): string[] {
  const parts: string[] = [];
  if ("connected_peers" in r) parts.push(`Peers: ${r.connected_peers}`);
  return parts;
}

/** Buffer stats normalized across input kinds; `null` means the metric does not apply. */
interface NormalizedBufferStats {
  /** RTP only: size of the jitter buffer (avg over last 10s). */
  input_buffer_avg_seconds: number | null;
  /** Effective buffer measured when data enters the buffer (min over last 10s). RTP: on_write, live sync: on_receive. */
  effective_buffer_on_enter_min_seconds: number | null;
  /** Effective buffer measured when data leaves the buffer (min over last 10s). RTP: on_pop, live sync: on_output. */
  effective_buffer_on_leave_min_seconds: number | null;
  /** Live sync only: content currently held back by the sync. */
  sync_buffer_seconds: number | null;
  /** Live sync only: remaining playback shift to reach the target buffer. */
  target_offset_distance_seconds: number | null;
  /** Live sync only: distance behind the pessimistic live edge estimate (margin before starving). */
  live_edge_lower_bound_seconds: number | null;
  /** Live sync only: distance behind the optimistic live edge estimate (total sync latency). */
  live_edge_upper_bound_seconds: number | null;
}

const EMPTY_BUFFER_STATS: NormalizedBufferStats = {
  input_buffer_avg_seconds: null,
  effective_buffer_on_enter_min_seconds: null,
  effective_buffer_on_leave_min_seconds: null,
  sync_buffer_seconds: null,
  target_offset_distance_seconds: null,
  live_edge_lower_bound_seconds: null,
  live_edge_upper_bound_seconds: null,
};

function normalizeRtp(s: RtpSlidingWindowBufferStats): NormalizedBufferStats {
  return {
    input_buffer_avg_seconds: s.input_buffer_avg_seconds,
    effective_buffer_on_enter_min_seconds: s.effective_buffer_on_write_min_seconds,
    effective_buffer_on_leave_min_seconds: s.effective_buffer_on_pop_min_seconds,
    sync_buffer_seconds: null,
    target_offset_distance_seconds: null,
    live_edge_lower_bound_seconds: null,
    live_edge_upper_bound_seconds: null,
  };
}

function normalizeSync(t: InputSyncTrack | null | undefined): NormalizedBufferStats {
  if (!t || t.mode !== "live") return EMPTY_BUFFER_STATS;
  return {
    input_buffer_avg_seconds: null,
    effective_buffer_on_enter_min_seconds:
      t.last_10_seconds.effective_buffer_on_receive_min_seconds,
    effective_buffer_on_leave_min_seconds: t.last_10_seconds.effective_buffer_on_output_min_seconds,
    sync_buffer_seconds: chartedSyncBufferSeconds(t.buffer),
    target_offset_distance_seconds: t.target_offset_distance_seconds,
    live_edge_lower_bound_seconds: t.live_edge_lower_bound_distance_seconds ?? null,
    live_edge_upper_bound_seconds: t.live_edge_upper_bound_distance_seconds ?? null,
  };
}

function getInputBufferStats(
  r: InputStatsReport,
): { video: NormalizedBufferStats; audio: NormalizedBufferStats } | null {
  switch (r.type) {
    case "rtp":
    case "whip":
    case "whep":
      return {
        video: normalizeRtp(r.video_rtp.last_10_seconds),
        audio: normalizeRtp(r.audio_rtp.last_10_seconds),
      };
    case "hls":
    case "rtmp":
      return { video: normalizeSync(r.video), audio: normalizeSync(r.audio) };
    default:
      return null;
  }
}

// ── Chart data ──────────────────────────────────────────────────────

interface BitratePoint {
  time: string;
  video: number;
  audio: number;
}

interface BufferPoint {
  time: string;
  video_input_buffer: number;
  video_effective_buffer_on_enter: number;
  video_effective_buffer_on_leave: number;
  audio_input_buffer: number;
  audio_effective_buffer_on_enter: number;
  audio_effective_buffer_on_leave: number;
  video_sync_buffer: number;
  audio_sync_buffer: number;
  video_target_offset: number;
  audio_target_offset: number;
  video_live_edge_lower: number;
  video_live_edge_upper: number;
  audio_live_edge_lower: number;
  audio_live_edge_upper: number;
}

const MAX_CHART_POINTS = 300;

// ── Styles ──────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "1rem",
  marginBottom: "1rem",
  background: "var(--bg-surface)",
};

const badgeStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 4,
  background: "var(--badge-bg)",
  fontSize: "0.8rem",
  fontWeight: 600,
  marginLeft: 8,
};

const trackRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  fontSize: "0.85rem",
  padding: "2px 0",
};

const trackLabelStyle: React.CSSProperties = {
  fontWeight: 600,
  width: "3.5rem",
  flexShrink: 0,
};

// Fields live in uniform fixed-width cells that wrap onto more lines when the card is narrow.
// Wrapping depends only on the card width, never on the values, so positions stay stable.
const trackFieldGridStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(11rem, 1fr))",
  columnGap: "1rem",
  rowGap: "2px",
};

const trackFieldStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "0.5rem",
  whiteSpace: "nowrap",
};

// Right-aligned tabular digits: values keep their position when the digit count changes,
// without zero padding.
const trackValueStyle: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  textAlign: "right",
};

const statRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "2rem",
  flexWrap: "wrap",
  margin: "0.5rem 0",
  fontSize: "0.9rem",
};

function ConnectionIndicator({ connected }: { connected: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: connected ? "#2ecc71" : "#e74c3c",
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      {connected ? "Connected" : "Disconnected"}
    </span>
  );
}

// ── Component ───────────────────────────────────────────────────────

export default function SmelterStats({ params }: { params: URLSearchParams }) {
  const [url, setUrl] = useSessionInput("stats:url", params, "url", "http://localhost:8081");
  const [status, setStatus] = useState<string | null>(null);
  const [report, setReport] = useState<StatsReport | null>(null);
  const [running, setRunning] = useState(false);

  // Accumulate bitrate_1_second history per input/output id
  const historyRef = useRef<Record<string, BitratePoint[]>>({});
  const bufferHistoryRef = useRef<Record<string, BufferPoint[]>>({});

  const fetchStats = useCallback(async () => {
    if (!url) return;
    try {
      const resp = await fetch(`${url.replace(/\/$/, "")}/stats`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: StatsReport = await resp.json();
      setReport(data);
      setStatus(null);

      const now = new Date().toLocaleTimeString();

      // Update history for inputs
      for (const [id, input] of Object.entries(data.inputs)) {
        const key = `input:${id}`;
        const tracks = getInputTracks(input);
        const prev = historyRef.current[key] ?? [];
        historyRef.current[key] = [
          ...prev.slice(-(MAX_CHART_POINTS - 1)),
          {
            time: now,
            video: tracks.video?.bitrate_1_second ?? NaN,
            audio: tracks.audio?.bitrate_1_second ?? NaN,
          },
        ];

        const bufferStats = getInputBufferStats(input);
        if (bufferStats) {
          const prevBuf = bufferHistoryRef.current[key] ?? [];
          bufferHistoryRef.current[key] = [
            ...prevBuf.slice(-(MAX_CHART_POINTS - 1)),
            {
              time: now,
              video_input_buffer: bufferStats.video.input_buffer_avg_seconds ?? NaN,
              video_effective_buffer_on_enter:
                bufferStats.video.effective_buffer_on_enter_min_seconds ?? NaN,
              video_effective_buffer_on_leave:
                bufferStats.video.effective_buffer_on_leave_min_seconds ?? NaN,
              video_sync_buffer: bufferStats.video.sync_buffer_seconds ?? NaN,
              video_target_offset: bufferStats.video.target_offset_distance_seconds ?? NaN,
              video_live_edge_lower: bufferStats.video.live_edge_lower_bound_seconds ?? NaN,
              video_live_edge_upper: bufferStats.video.live_edge_upper_bound_seconds ?? NaN,
              audio_input_buffer: bufferStats.audio.input_buffer_avg_seconds ?? NaN,
              audio_effective_buffer_on_enter:
                bufferStats.audio.effective_buffer_on_enter_min_seconds ?? NaN,
              audio_effective_buffer_on_leave:
                bufferStats.audio.effective_buffer_on_leave_min_seconds ?? NaN,
              audio_sync_buffer: bufferStats.audio.sync_buffer_seconds ?? NaN,
              audio_target_offset: bufferStats.audio.target_offset_distance_seconds ?? NaN,
              audio_live_edge_lower: bufferStats.audio.live_edge_lower_bound_seconds ?? NaN,
              audio_live_edge_upper: bufferStats.audio.live_edge_upper_bound_seconds ?? NaN,
            },
          ];
        }
      }

      // Update history for outputs
      for (const [id, output] of Object.entries(data.outputs)) {
        const key = `output:${id}`;
        const tracks = getOutputTracks(output);
        const prev = historyRef.current[key] ?? [];
        historyRef.current[key] = [
          ...prev.slice(-(MAX_CHART_POINTS - 1)),
          {
            time: now,
            video: tracks.video?.bitrate_1_second ?? NaN,
            audio: tracks.audio?.bitrate_1_second ?? NaN,
          },
        ];
      }
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [url]);

  useEffect(() => {
    if (!running || !url) return;
    fetchStats();
    const id = setInterval(fetchStats, 1000);
    return () => clearInterval(id);
  }, [running, url, fetchStats]);

  const connect = useCallback(() => {
    if (!url) {
      setStatus("Please enter a Smelter instance URL.");
      return;
    }
    historyRef.current = {};
    bufferHistoryRef.current = {};
    saveToHistory("stats:url", url);
    setRunning(true);
  }, [url]);

  return (
    <>
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <SuggestInput
          historyKey="stats:url"
          value={url}
          onChange={setUrl}
          placeholder="http://localhost:8004"
          label="Smelter Instance URL"
        />
        <div style={{ display: "flex", alignItems: "flex-end", gap: "0.5rem" }}>
          <button
            onClick={running ? () => setRunning(false) : connect}
            style={{ padding: "0.5rem 1rem", fontSize: "0.9rem", cursor: "pointer" }}
          >
            {running ? "Stop" : "Connect"}
          </button>
        </div>
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

      {report && (
        <>
          {Object.keys(report.inputs).length > 0 && (
            <>
              <h2 style={{ fontSize: "1.1rem", margin: "1.5rem 0 0.5rem" }}>Inputs</h2>
              {Object.entries(report.inputs).map(([id, input]) => {
                const tracks = getInputTracks(input);
                const history = historyRef.current[`input:${id}`] ?? [];
                const bufferHistory = bufferHistoryRef.current[`input:${id}`] ?? [];
                const trackInfo = inputTrackInfo(input);
                return (
                  <div key={`input:${id}`} style={cardStyle}>
                    <strong>{id}</strong>
                    <span style={badgeStyle}>{input.type}</span>
                    <div style={statRowStyle}>
                      {"is_connected" in input && (
                        <ConnectionIndicator connected={input.is_connected} />
                      )}
                      <span>
                        Video (1m avg): <strong>{formatTrackBitrate(tracks.video)}</strong>
                      </span>
                      <span>
                        Audio (1m avg): <strong>{formatTrackBitrate(tracks.audio)}</strong>
                      </span>
                    </div>
                    <TrackInfoTable rows={trackInfo} />
                    <BitrateChart data={history} />
                    <BufferChart data={bufferHistory} />
                  </div>
                );
              })}
            </>
          )}

          {Object.keys(report.outputs).length > 0 && (
            <>
              <h2 style={{ fontSize: "1.1rem", margin: "1.5rem 0 0.5rem" }}>Outputs</h2>
              {Object.entries(report.outputs).map(([id, output]) => {
                const tracks = getOutputTracks(output);
                const history = historyRef.current[`output:${id}`] ?? [];
                const extra = outputExtraInfo(output);
                return (
                  <div key={`output:${id}`} style={cardStyle}>
                    <strong>{id}</strong>
                    <span style={badgeStyle}>{output.type}</span>
                    <div style={statRowStyle}>
                      {"is_connected" in output && (
                        <ConnectionIndicator connected={output.is_connected} />
                      )}
                      <span>
                        Video (1m avg): <strong>{formatTrackBitrate(tracks.video)}</strong>
                      </span>
                      <span>
                        Audio (1m avg): <strong>{formatTrackBitrate(tracks.audio)}</strong>
                      </span>
                      {extra.map((e, i) => (
                        <span key={i} style={{ color: "var(--text-muted)" }}>
                          {e}
                        </span>
                      ))}
                    </div>
                    <BitrateChart data={history} />
                  </div>
                );
              })}
            </>
          )}

          {Object.keys(report.inputs).length === 0 && Object.keys(report.outputs).length === 0 && (
            <p style={{ color: "var(--text-muted)" }}>No inputs or outputs registered.</p>
          )}
        </>
      )}
    </>
  );
}

function BufferChart({ data }: { data: BufferPoint[] }) {
  if (data.length === 0) return null;

  const toMs = (v: number) => (Number.isFinite(v) ? v * 1000 : NaN);
  // Convert to milliseconds for display
  const chartData = data.map((d) => ({
    time: d.time,
    video_input_buffer: toMs(d.video_input_buffer),
    video_effective_buffer_on_enter: toMs(d.video_effective_buffer_on_enter),
    video_effective_buffer_on_leave: toMs(d.video_effective_buffer_on_leave),
    audio_input_buffer: toMs(d.audio_input_buffer),
    audio_effective_buffer_on_enter: toMs(d.audio_effective_buffer_on_enter),
    audio_effective_buffer_on_leave: toMs(d.audio_effective_buffer_on_leave),
    video_sync_buffer: toMs(d.video_sync_buffer),
    audio_sync_buffer: toMs(d.audio_sync_buffer),
    video_target_offset: toMs(d.video_target_offset),
    audio_target_offset: toMs(d.audio_target_offset),
    video_live_edge_lower: toMs(d.video_live_edge_lower),
    video_live_edge_upper: toMs(d.video_live_edge_upper),
    audio_live_edge_lower: toMs(d.audio_live_edge_lower),
    audio_live_edge_upper: toMs(d.audio_live_edge_upper),
  }));
  const has = (key: keyof (typeof chartData)[number]) =>
    chartData.some((d) => Number.isFinite(d[key] as number));

  return (
    <>
      <div
        style={{
          fontSize: "0.85rem",
          fontWeight: 600,
          margin: "0.75rem 0 0.25rem",
          color: "var(--text-muted)",
        }}
      >
        Buffer (last 10s window)
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="time"
            tick={{ fontSize: 11, fill: "var(--text-muted)" }}
            interval="preserveStartEnd"
            stroke="var(--border)"
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--text-muted)" }}
            unit=" ms"
            width={80}
            stroke="var(--border)"
          />
          <Tooltip
            formatter={(v: number) => `${v.toFixed(1)} ms`}
            contentStyle={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text)",
            }}
          />
          {has("video_input_buffer") && (
            <Line
              type="monotone"
              dataKey="video_input_buffer"
              name="Video Input Buffer"
              stroke="#8884d8"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          )}
          {has("video_effective_buffer_on_enter") && (
            <Line
              type="monotone"
              dataKey="video_effective_buffer_on_enter"
              name="Video Effective Buffer (on enter, min)"
              stroke="#8884d8"
              strokeWidth={2}
              strokeDasharray="2 4"
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          )}
          {has("video_effective_buffer_on_leave") && (
            <Line
              type="monotone"
              dataKey="video_effective_buffer_on_leave"
              name="Video Effective Buffer (on leave, min)"
              stroke="#8884d8"
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
              isAnimationActive={false}
            />
          )}
          {has("audio_input_buffer") && (
            <Line
              type="monotone"
              dataKey="audio_input_buffer"
              name="Audio Input Buffer"
              stroke="#82ca9d"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          )}
          {has("audio_effective_buffer_on_enter") && (
            <Line
              type="monotone"
              dataKey="audio_effective_buffer_on_enter"
              name="Audio Effective Buffer (on enter, min)"
              stroke="#82ca9d"
              strokeWidth={2}
              strokeDasharray="2 4"
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          )}
          {has("audio_effective_buffer_on_leave") && (
            <Line
              type="monotone"
              dataKey="audio_effective_buffer_on_leave"
              name="Audio Effective Buffer (on leave, min)"
              stroke="#82ca9d"
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
              isAnimationActive={false}
            />
          )}
          {has("video_sync_buffer") && (
            <Line
              type="monotone"
              dataKey="video_sync_buffer"
              name="Video Sync Buffer"
              stroke="#8884d8"
              strokeWidth={2}
              strokeDasharray="1 3"
              dot={false}
              isAnimationActive={false}
            />
          )}
          {has("audio_sync_buffer") && (
            <Line
              type="monotone"
              dataKey="audio_sync_buffer"
              name="Audio Sync Buffer"
              stroke="#82ca9d"
              strokeWidth={2}
              strokeDasharray="1 3"
              dot={false}
              isAnimationActive={false}
            />
          )}
          {has("video_target_offset") && (
            <Line
              type="monotone"
              dataKey="video_target_offset"
              name="Video Target Offset Distance"
              stroke="#e0a030"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          )}
          {has("audio_target_offset") && (
            <Line
              type="monotone"
              dataKey="audio_target_offset"
              name="Audio Target Offset Distance"
              stroke="#e0a030"
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
              isAnimationActive={false}
            />
          )}
          {has("video_live_edge_lower") && (
            <Line
              type="monotone"
              dataKey="video_live_edge_lower"
              name="Video Live Edge (lower bound)"
              stroke="#d05070"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          )}
          {has("video_live_edge_upper") && (
            <Line
              type="monotone"
              dataKey="video_live_edge_upper"
              name="Video Live Edge (upper bound)"
              stroke="#d05070"
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
              isAnimationActive={false}
            />
          )}
          {has("audio_live_edge_lower") && (
            <Line
              type="monotone"
              dataKey="audio_live_edge_lower"
              name="Audio Live Edge (lower bound)"
              stroke="#c07020"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          )}
          {has("audio_live_edge_upper") && (
            <Line
              type="monotone"
              dataKey="audio_live_edge_upper"
              name="Audio Live Edge (upper bound)"
              stroke="#c07020"
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
              isAnimationActive={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

function BitrateChart({ data }: { data: BitratePoint[] }) {
  if (data.length === 0) return null;

  // Convert to kbps for display
  const chartData = data.map((d) => ({
    time: d.time,
    video: d.video / 1000,
    audio: d.audio / 1000,
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 11, fill: "var(--text-muted)" }}
          interval="preserveStartEnd"
          stroke="var(--border)"
        />
        <YAxis
          tick={{ fontSize: 11, fill: "var(--text-muted)" }}
          unit=" kbps"
          width={80}
          stroke="var(--border)"
        />
        <Tooltip
          formatter={(v: number) => `${v.toFixed(1)} kbps`}
          contentStyle={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text)",
          }}
        />
        <Line
          type="monotone"
          dataKey="video"
          name="Video"
          stroke="#8884d8"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="audio"
          name="Audio"
          stroke="#82ca9d"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
