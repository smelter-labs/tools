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

interface SlidingWindowBufferStats {
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
  last_10_seconds: SlidingWindowBufferStats;
}

interface HlsTrack extends TrackBitrate {
  last_10_seconds: SlidingWindowBufferStats;
}

interface StatsReport {
  inputs: Record<string, InputStatsReport>;
  outputs: Record<string, OutputStatsReport>;
}

type InputStatsReport =
  | { type: "rtp" | "whip" | "whep"; video_rtp: RtpTrack; audio_rtp: RtpTrack }
  | { type: "hls"; video: HlsTrack; audio: HlsTrack }
  | { type: "rtmp" | "mp4"; video: TrackBitrate; audio: TrackBitrate };

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
      return { video: r.video_rtp, audio: r.audio_rtp };
    case "hls":
    case "rtmp":
    case "mp4":
      return { video: r.video, audio: r.audio };
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
    const a = r.audio_rtp as RtpTrack;
    parts.push(`Video pkts: ${v.packets_received} (lost ${v.packets_lost})`);
    parts.push(`Audio pkts: ${a.packets_received} (lost ${a.packets_lost})`);
  }
  return parts;
}

function getInputBufferStats(
  r: InputStatsReport,
): { video: SlidingWindowBufferStats; audio: SlidingWindowBufferStats } | null {
  switch (r.type) {
    case "rtp":
    case "whip":
    case "whep":
      return { video: r.video_rtp.last_10_seconds, audio: r.audio_rtp.last_10_seconds };
    case "hls":
      return { video: r.video.last_10_seconds, audio: r.audio.last_10_seconds };
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
  video_effective_buffer: number;
  audio_input_buffer: number;
  audio_effective_buffer: number;
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
              video_effective_buffer: bufferStats.video.effective_buffer_avg_seconds,
              audio_input_buffer: bufferStats.audio.input_buffer_avg_seconds,
              audio_effective_buffer: bufferStats.audio.effective_buffer_avg_seconds,
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
                      {extra.map((e, i) => (
                        <span key={i} style={{ color: "var(--text-muted)" }}>
                          {e}
                        </span>
                      ))}
                    </div>
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

  // Convert to milliseconds for display
  const chartData = data.map((d) => ({
    time: d.time,
    video_input_buffer: d.video_input_buffer * 1000,
    video_effective_buffer: d.video_effective_buffer * 1000,
    audio_input_buffer: d.audio_input_buffer * 1000,
    audio_effective_buffer: d.audio_effective_buffer * 1000,
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
            dataKey="video_effective_buffer"
            name="Video Effective Buffer"
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
            dataKey="audio_effective_buffer"
            name="Audio Effective Buffer"
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
