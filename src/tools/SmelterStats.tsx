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
  ReferenceLine,
} from "recharts";

// ── Types matching the /stats API response ──────────────────────────

interface TrackBitrate {
  bitrate_1_second: number;
  bitrate_1_minute: number;
}

interface RtpSlidingWindowBufferStats {
  effective_buffer_on_write_avg_seconds?: number;
  effective_buffer_on_write_max_seconds?: number;
  effective_buffer_on_write_min_seconds?: number;
  effective_buffer_on_pop_avg_seconds?: number;
  effective_buffer_on_pop_max_seconds?: number;
  effective_buffer_on_pop_min_seconds?: number;
  // FALLBACK: remove these once all servers expose the *_on_pop_* fields above.
  effective_buffer_avg_seconds?: number;
  effective_buffer_max_seconds?: number;
  effective_buffer_min_seconds?: number;
  input_buffer_avg_seconds: number;
  input_buffer_max_seconds: number;
  input_buffer_min_seconds: number;
}

interface HlsSlidingWindowBufferStats {
  effective_buffer_avg_seconds: number;
  effective_buffer_max_seconds: number;
  effective_buffer_min_seconds: number;
  input_buffer_avg_seconds: number;
  input_buffer_max_seconds: number;
  input_buffer_min_seconds: number;
}

interface RtpTrack extends TrackBitrate {
  packets_lost: number;
  packets_received: number;
  last_10_seconds: RtpSlidingWindowBufferStats;
}

interface HlsTrack extends TrackBitrate {
  last_10_seconds: HlsSlidingWindowBufferStats;
}

interface AudioMixerSlidingWindowStats {
  drift_avg_seconds: number;
  drift_min_seconds: number;
  drift_max_seconds: number;
  buffer_duration_avg_seconds: number;
  buffer_duration_min_seconds: number;
  buffer_duration_max_seconds: number;
  discontinuities_count: number;
}

interface AudioMixerStats {
  discontinuities_total: number;
  last_1_second: AudioMixerSlidingWindowStats;
  last_10_seconds: AudioMixerSlidingWindowStats;
}

interface StatsReport {
  inputs: Record<string, InputStatsReport>;
  outputs: Record<string, OutputStatsReport>;
}

type InputStatsReport =
  | {
      type: "rtp" | "whip" | "whep";
      video_rtp: RtpTrack;
      audio: { rtp: RtpTrack; mixer: AudioMixerStats };
    }
  | { type: "hls"; video: HlsTrack; audio: { track: HlsTrack; mixer: AudioMixerStats } }
  | {
      type: "rtmp" | "mp4";
      video: TrackBitrate;
      audio: { track: TrackBitrate; mixer: AudioMixerStats };
    };

type OutputStatsReport =
  | { type: "whep"; video: TrackBitrate; audio: TrackBitrate; connected_peers: number }
  | { type: "whip"; video: TrackBitrate; audio: TrackBitrate; is_connected: boolean }
  | { type: "hls" | "mp4" | "rtmp" | "rtp"; video: TrackBitrate; audio: TrackBitrate };

// ── Helpers ─────────────────────────────────────────────────────────

function getInputTracks(r: InputStatsReport): { video: TrackBitrate; audio: TrackBitrate } {
  switch (r.type) {
    case "rtp":
    case "whip":
    case "whep":
      return { video: r.video_rtp, audio: r.audio.rtp };
    case "hls":
      return { video: r.video, audio: r.audio.track };
    case "rtmp":
    case "mp4":
      return { video: r.video, audio: r.audio.track };
  }
}

function getAudioMixerStats(r: InputStatsReport): AudioMixerStats | null {
  switch (r.type) {
    case "rtp":
    case "whip":
    case "whep":
    case "hls":
    case "rtmp":
    case "mp4":
      return r.audio.mixer ?? null;
  }
}

function getOutputTracks(r: OutputStatsReport): { video: TrackBitrate; audio: TrackBitrate } {
  return { video: r.video, audio: r.audio };
}

function formatBitrate(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} kbps`;
  return `${bps} bps`;
}

function extraInfo(r: InputStatsReport | OutputStatsReport): string[] {
  const parts: string[] = [];
  if ("connected_peers" in r) parts.push(`Peers: ${r.connected_peers}`);
  if ("is_connected" in r) parts.push(r.is_connected ? "Connected" : "Disconnected");
  if ("video_rtp" in r) {
    const v = r.video_rtp as RtpTrack;
    const a = (r as Extract<InputStatsReport, { type: "rtp" | "whip" | "whep" }>).audio.rtp;
    parts.push(`Video pkts: ${v.packets_received} (lost ${v.packets_lost})`);
    parts.push(`Audio pkts: ${a.packets_received} (lost ${a.packets_lost})`);
  }
  return parts;
}

interface NormalizedBufferStats {
  input_buffer_avg_seconds: number;
  effective_buffer_on_write_min_seconds: number | null;
  effective_buffer_on_pop_min_seconds: number;
}

function normalizeRtp(s: RtpSlidingWindowBufferStats): NormalizedBufferStats {
  return {
    input_buffer_avg_seconds: s.input_buffer_avg_seconds,
    effective_buffer_on_write_min_seconds: s.effective_buffer_on_write_min_seconds ?? null,
    effective_buffer_on_pop_min_seconds:
      s.effective_buffer_on_pop_min_seconds ??
      // FALLBACK: legacy field name — drop this `??` branch once servers ship the split fields.
      s.effective_buffer_min_seconds ??
      0,
  };
}

function normalizeHls(s: HlsSlidingWindowBufferStats): NormalizedBufferStats {
  return {
    input_buffer_avg_seconds: s.input_buffer_avg_seconds,
    effective_buffer_on_write_min_seconds: null,
    effective_buffer_on_pop_min_seconds: s.effective_buffer_min_seconds,
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
        audio: normalizeRtp(r.audio.rtp.last_10_seconds),
      };
    case "hls":
      return {
        video: normalizeHls(r.video.last_10_seconds),
        audio: normalizeHls(r.audio.track.last_10_seconds),
      };
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
  video_effective_buffer_on_write: number;
  video_effective_buffer_on_pop: number;
  audio_input_buffer: number;
  audio_effective_buffer_on_write: number;
  audio_effective_buffer_on_pop: number;
}

interface AudioMixerPoint {
  time: string;
  drift_avg: number;
  drift_min: number;
  drift_max: number;
  buffer_duration_avg: number;
  buffer_duration_min: number;
  buffer_duration_max: number;
  // Marker fields. `discontinuity` is set to a number only on samples where
  // a new discontinuity was observed, so a ReferenceLine can be drawn at
  // that x value.
  discontinuity: boolean;
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

const statRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "2rem",
  flexWrap: "wrap",
  margin: "0.5rem 0",
  fontSize: "0.9rem",
};

// ── Component ───────────────────────────────────────────────────────

export default function SmelterStats({ params }: { params: URLSearchParams }) {
  const [url, setUrl] = useSessionInput("stats:url", params, "url", "http://localhost:8081");
  const [status, setStatus] = useState<string | null>(null);
  const [report, setReport] = useState<StatsReport | null>(null);
  const [running, setRunning] = useState(false);

  // Accumulate bitrate_1_second history per input/output id
  const historyRef = useRef<Record<string, BitratePoint[]>>({});
  const bufferHistoryRef = useRef<Record<string, BufferPoint[]>>({});
  const audioMixerHistoryRef = useRef<Record<string, AudioMixerPoint[]>>({});
  // Last seen `discontinuities_total` per input so we can detect new ones.
  const lastDiscontinuityRef = useRef<Record<string, number>>({});

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
          { time: now, video: tracks.video.bitrate_1_second, audio: tracks.audio.bitrate_1_second },
        ];

        const bufferStats = getInputBufferStats(input);
        if (bufferStats) {
          const prevBuf = bufferHistoryRef.current[key] ?? [];
          bufferHistoryRef.current[key] = [
            ...prevBuf.slice(-(MAX_CHART_POINTS - 1)),
            {
              time: now,
              video_input_buffer: bufferStats.video.input_buffer_avg_seconds,
              video_effective_buffer_on_write:
                bufferStats.video.effective_buffer_on_write_min_seconds ?? NaN,
              video_effective_buffer_on_pop: bufferStats.video.effective_buffer_on_pop_min_seconds,
              audio_input_buffer: bufferStats.audio.input_buffer_avg_seconds,
              audio_effective_buffer_on_write:
                bufferStats.audio.effective_buffer_on_write_min_seconds ?? NaN,
              audio_effective_buffer_on_pop: bufferStats.audio.effective_buffer_on_pop_min_seconds,
            },
          ];
        }

        const mixer = getAudioMixerStats(input);
        if (mixer) {
          const w = mixer.last_1_second;
          const prevMix = audioMixerHistoryRef.current[key] ?? [];
          const prevTotal = lastDiscontinuityRef.current[key];
          // Mark a sample as a discontinuity boundary when `discontinuities_total`
          // grows since the previous poll. Ignore the very first sample so we
          // don't draw a marker just because we have no baseline.
          const hasDiscontinuity =
            prevTotal !== undefined && mixer.discontinuities_total > prevTotal;
          lastDiscontinuityRef.current[key] = mixer.discontinuities_total;
          audioMixerHistoryRef.current[key] = [
            ...prevMix.slice(-(MAX_CHART_POINTS - 1)),
            {
              time: now,
              drift_avg: w.drift_avg_seconds,
              drift_min: w.drift_min_seconds,
              drift_max: w.drift_max_seconds,
              buffer_duration_avg: w.buffer_duration_avg_seconds,
              buffer_duration_min: w.buffer_duration_min_seconds,
              buffer_duration_max: w.buffer_duration_max_seconds,
              discontinuity: hasDiscontinuity,
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
          { time: now, video: tracks.video.bitrate_1_second, audio: tracks.audio.bitrate_1_second },
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
    audioMixerHistoryRef.current = {};
    lastDiscontinuityRef.current = {};
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
                const audioMixerHistory = audioMixerHistoryRef.current[`input:${id}`] ?? [];
                const mixer = getAudioMixerStats(input);
                const extra = extraInfo(input);
                return (
                  <div key={`input:${id}`} style={cardStyle}>
                    <strong>{id}</strong>
                    <span style={badgeStyle}>{input.type}</span>
                    <div style={statRowStyle}>
                      <span>
                        Video (1m avg):{" "}
                        <strong>{formatBitrate(tracks.video.bitrate_1_minute)}</strong>
                      </span>
                      <span>
                        Audio (1m avg):{" "}
                        <strong>{formatBitrate(tracks.audio.bitrate_1_minute)}</strong>
                      </span>
                      {mixer && (
                        <span style={{ color: "var(--text-muted)" }}>
                          Audio mixer discontinuities: {mixer.discontinuities_total}
                        </span>
                      )}
                      {extra.map((e, i) => (
                        <span key={i} style={{ color: "var(--text-muted)" }}>
                          {e}
                        </span>
                      ))}
                    </div>
                    <BitrateChart data={history} />
                    <BufferChart data={bufferHistory} />
                    <AudioMixerChart data={audioMixerHistory} />
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
                const extra = extraInfo(output);
                return (
                  <div key={`output:${id}`} style={cardStyle}>
                    <strong>{id}</strong>
                    <span style={badgeStyle}>{output.type}</span>
                    <div style={statRowStyle}>
                      <span>
                        Video (1m avg):{" "}
                        <strong>{formatBitrate(tracks.video.bitrate_1_minute)}</strong>
                      </span>
                      <span>
                        Audio (1m avg):{" "}
                        <strong>{formatBitrate(tracks.audio.bitrate_1_minute)}</strong>
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
    video_effective_buffer_on_write: toMs(d.video_effective_buffer_on_write),
    video_effective_buffer_on_pop: toMs(d.video_effective_buffer_on_pop),
    audio_input_buffer: toMs(d.audio_input_buffer),
    audio_effective_buffer_on_write: toMs(d.audio_effective_buffer_on_write),
    audio_effective_buffer_on_pop: toMs(d.audio_effective_buffer_on_pop),
  }));

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
        Buffer (avg over last 10s)
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
          <Line
            type="monotone"
            dataKey="video_input_buffer"
            name="Video Input Buffer"
            stroke="#8884d8"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="video_effective_buffer_on_write"
            name="Video Effective Buffer (on write, min)"
            stroke="#8884d8"
            strokeWidth={2}
            strokeDasharray="2 4"
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="video_effective_buffer_on_pop"
            name="Video Effective Buffer (on pop, min)"
            stroke="#8884d8"
            strokeWidth={2}
            strokeDasharray="5 5"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="audio_input_buffer"
            name="Audio Input Buffer"
            stroke="#82ca9d"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="audio_effective_buffer_on_write"
            name="Audio Effective Buffer (on write, min)"
            stroke="#82ca9d"
            strokeWidth={2}
            strokeDasharray="2 4"
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="audio_effective_buffer_on_pop"
            name="Audio Effective Buffer (on pop, min)"
            stroke="#82ca9d"
            strokeWidth={2}
            strokeDasharray="5 5"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

function AudioMixerChart({ data }: { data: AudioMixerPoint[] }) {
  if (data.length === 0) return null;

  const toMs = (v: number) => (Number.isFinite(v) ? v * 1000 : NaN);
  const chartData = data.map((d) => ({
    time: d.time,
    drift_avg: toMs(d.drift_avg),
    drift_min: toMs(d.drift_min),
    drift_max: toMs(d.drift_max),
    buffer_duration_avg: toMs(d.buffer_duration_avg),
    buffer_duration_min: toMs(d.buffer_duration_min),
    buffer_duration_max: toMs(d.buffer_duration_max),
  }));
  const discontinuityTimes = data.filter((d) => d.discontinuity).map((d) => d.time);

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
        Audio mixer — drift &amp; buffer duration (last 1s window)
      </div>
      <ResponsiveContainer width="100%" height={220}>
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
            formatter={(v: number) => `${v.toFixed(2)} ms`}
            contentStyle={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text)",
            }}
          />
          {discontinuityTimes.map((t, i) => (
            <ReferenceLine
              key={`disc-${i}-${t}`}
              x={t}
              stroke="var(--error, #e15759)"
              strokeDasharray="4 2"
              label={
                i === 0
                  ? {
                      value: "discontinuity",
                      position: "top",
                      fill: "var(--error, #e15759)",
                      fontSize: 10,
                    }
                  : undefined
              }
            />
          ))}
          <Line
            type="monotone"
            dataKey="drift_avg"
            name="Drift (avg)"
            stroke="#e07b00"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="drift_min"
            name="Drift (min)"
            stroke="#e07b00"
            strokeWidth={1}
            strokeDasharray="3 3"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="drift_max"
            name="Drift (max)"
            stroke="#e07b00"
            strokeWidth={1}
            strokeDasharray="3 3"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="buffer_duration_avg"
            name="Buffer duration (avg)"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="buffer_duration_min"
            name="Buffer duration (min)"
            stroke="#3b82f6"
            strokeWidth={1}
            strokeDasharray="3 3"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="buffer_duration_max"
            name="Buffer duration (max)"
            stroke="#3b82f6"
            strokeWidth={1}
            strokeDasharray="3 3"
            dot={false}
            isAnimationActive={false}
          />
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
