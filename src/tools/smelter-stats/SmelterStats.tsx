import { useState, useEffect, useRef, useCallback } from "react";
import { useSessionInput } from "../../ui/useSessionInput.ts";
import { useLocalStorageState } from "../../ui/useLocalStorageState.ts";
import SuggestInput, { saveToHistory } from "../../ui/SuggestInput.tsx";
import { formatBitrate } from "../../ui/format.ts";
import type { ToolMeta } from "../registry.ts";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
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

/** `RTP` jitter buffer used in `RTP`, `WHIP` and `WHEP` inputs. */
interface RtpJitterBuffer extends TrackBitrate {
  packets_lost: number;
  packets_received: number;
  last_10_seconds: RtpSlidingWindowBufferStats;
}

type AudioMixerInputState = "playing" | "waiting_for_input";

interface AudioMixerInputFormat {
  sample_rate: number;
  channels: "mono" | "stereo";
}

/** Counters reported both as totals and over the sliding window. */
interface AudioMixerCounters {
  /** Gaps or overlaps (10ms or longer) between timestamps of consecutive input chunks. */
  timestamp_discontinuities: number;
  /** Mixer ran out of input audio and had to interrupt the playback. */
  underruns: number;
  /** Silence inserted because input timestamps got ahead of the received audio by more than 40ms. */
  gaps_inserted: number;
  /** Audio dropped because input timestamps fell behind the received audio by more than 500ms. */
  drops: number;
  /** End of input audio extended with generated audio to cover a gap. */
  concealments: number;
  fade_ins: number;
  fade_outs: number;
}

interface AudioMixerSlidingWindowStats extends AudioMixerCounters {
  /**
   * Difference between input timestamps and the position on the output timeline where the input
   * audio is played (A/V desync introduced by the input). Positive when audio is played ahead of
   * its timestamps, negative when behind. Values within 2ms are not corrected.
   */
  drift_avg_seconds: number;
  drift_max_seconds: number;
  drift_min_seconds: number;
  /** Duration of input audio buffered in the mixer, waiting to be played. */
  input_buffer_avg_seconds: number;
  input_buffer_max_seconds: number;
  input_buffer_min_seconds: number;
}

/** Audio mixer processing of an input. */
interface AudioMixerInput extends AudioMixerCounters {
  state: AudioMixerInputState;
  input_format?: AudioMixerInputFormat | null;
  last_10_seconds: AudioMixerSlidingWindowStats;
}

type SimpleSyncTrackState = "initial_buffering" | "running";

/** Non-live stream, timestamps are normalized to start at zero. */
interface SimpleSyncTrack extends TrackBitrate {
  mode: "simple";
  /** State of the synchronization. */
  state: SimpleSyncTrackState;
}

/**
 * - `waiting_for_start`: chunks are held back until the live edge is estimated.
 * - `started_shared`: timestamp offset is shared with the other track; the buffer is sized from the
 *   live edge of both tracks combined.
 * - `started_independent`: tracks are on unrelated timelines. The leader (audio when it runs) sizes
 *   the buffer from its own live edge; the secondary track follows the leader, shifted by the
 *   distance between their live edges.
 */
type LiveSyncTrackState = "waiting_for_start" | "started_shared" | "started_independent";

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

/** Content currently held in the sync buffer. */
type LiveSyncBuffer =
  /** FIFO sync buffer (`RTMP`, `HLS`). */
  | { type: "fifo"; duration_seconds: number }
  /** Sync buffer that reorders out-of-order delivery (`MoQ`). */
  | {
      type: "jitter";
      duration_seconds: number;
      /** Whether the next chunk is held back behind a gap that might still be filled. */
      waiting_for_gap: boolean;
    };

/** Live stream, synchronized to the estimated live edge. */
interface LiveSyncTrack extends TrackBitrate {
  mode: "live";
  state: LiveSyncTrackState;
  discontinuities_detected: number;
  /**
   * Remaining shift of the playback position until the timestamp offset of the track reaches its
   * target. Positive when the buffer is being shrunk, negative when grown, zero when converged.
   * For the secondary track of `started_independent` it is the remaining shift relative to the
   * leader's final position.
   */
  target_offset_distance_seconds: number;
  /**
   * How far the playback position is behind the pessimistic live edge estimate (content arriving
   * as slow as the slowest recent chunk). Margin before playback runs out of content.
   * Measured against the estimate of both tracks combined in `started_shared` and of this track
   * alone in `started_independent`. `null` before the track starts.
   */
  live_edge_lower_bound_distance_seconds?: number | null;
  /**
   * How far the playback position is behind the optimistic live edge estimate (content arriving
   * as fast as the fastest recent chunk). Total latency introduced by the synchronization.
   * Measured against the estimate of both tracks combined in `started_shared` and of this track
   * alone in `started_independent`. `null` before the track starts.
   */
  live_edge_upper_bound_distance_seconds?: number | null;
  /**
   * Like `live_edge_upper_bound_distance_seconds`, but the estimate only looks back over the last
   * few seconds instead of the full window, so it reacts to a latency change within seconds.
   * Never larger than the full-window value; it drops below it when the stream slipped (content
   * arriving slower than real time) and the full window still remembers the earlier, faster
   * delivery. `null` before the track starts or when nothing arrived within the window.
   */
  live_edge_recent_upper_bound_distance_seconds?: number | null;
  buffer: LiveSyncBuffer;
  last_10_seconds: LiveSyncSlidingWindowStats;
}

/** Track synchronized by the input sync (`RTMP`, `HLS`, `MoQ`). */
type InputSyncTrack = SimpleSyncTrack | LiveSyncTrack;

interface RtpVideoTrack extends TrackBitrate {
  jitter_buffer: RtpJitterBuffer;
}

interface RtpAudioTrack extends RtpVideoTrack {
  mixer: AudioMixerInput;
}

interface SyncVideoTrack extends TrackBitrate {
  /** `null` until the track is registered. */
  sync?: InputSyncTrack | null;
}

interface SyncAudioTrack extends SyncVideoTrack {
  mixer: AudioMixerInput;
}

interface Mp4AudioTrack extends TrackBitrate {
  mixer: AudioMixerInput;
}

interface StatsReport {
  inputs: Record<string, InputStatsReport>;
  outputs: Record<string, OutputStatsReport>;
}

type InputStatsReport =
  | {
      type: "rtp" | "whip" | "whep";
      video?: RtpVideoTrack | null;
      audio?: RtpAudioTrack | null;
    }
  | {
      type: "hls" | "moq_server" | "moq_client";
      video?: SyncVideoTrack | null;
      audio?: SyncAudioTrack | null;
    }
  | {
      type: "rtmp";
      is_connected: boolean;
      video?: SyncVideoTrack | null;
      audio?: SyncAudioTrack | null;
    }
  | { type: "mp4"; video?: TrackBitrate | null; audio?: Mp4AudioTrack | null };

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
  return { video: r.video ?? null, audio: r.audio ?? null };
}

function getInputMixer(r: InputStatsReport): AudioMixerInput | null {
  return r.audio?.mixer ?? null;
}

function getOutputTracks(r: OutputStatsReport): Tracks {
  return { video: r.video, audio: r.audio };
}

function formatTrackBitrate(t: TrackBitrate | null): string {
  return t ? formatBitrate(t.bitrate_1_minute) : "—";
}

function formatSeconds(s: number): string {
  return `${(s * 1000).toFixed(0)} ms`;
}

function outputExtraInfo(r: OutputStatsReport): string[] {
  const parts: string[] = [];
  if ("connected_peers" in r) parts.push(`Peers: ${r.connected_peers}`);
  return parts;
}

function matchesFilter(filter: string, id: string, type: string): boolean {
  const f = filter.trim().toLowerCase();
  return f === "" || id.toLowerCase().includes(f) || type.includes(f);
}

type MediaTrack = "video" | "audio";
const MEDIA_TRACKS: MediaTrack[] = ["video", "audio"];

type Agg = "avg" | "min" | "max";
const AGGS: Agg[] = ["avg", "min", "max"];

// ── Sections ────────────────────────────────────────────────────────

/** Card sections; each has its own fields and chart. Per-card chips toggle whole sections. */
type Section = "bitrate" | "jitter" | "sync" | "mixer";
const ALL_SECTIONS: Section[] = ["bitrate", "jitter", "sync", "mixer"];

/** Field in the card table. `id` is relative to `<section>.fields`; nested fields share a cell group. */
interface FieldDef {
  id: string;
  label: string;
  children?: FieldDef[];
}

type Unit = "ms" | "kbps";

/** Chart metric; becomes one series per track (if `perTrack`) and per aggregate (if `aggregated`). */
interface MetricDef {
  id: string;
  label: string;
  perTrack: boolean;
  aggregated: boolean;
  /** Video/audio colors for per-track metrics, a single color otherwise. */
  colors: [string, string] | string;
  /** Aggregates shown by default; all when omitted. */
  defaultAggs?: Agg[];
}

interface SectionDef {
  label: string;
  /** Short name for the per-card chip. */
  chip: string;
  fields: FieldDef[];
  unit: Unit;
  metrics: MetricDef[];
}

const MIXER_COUNTERS: { key: keyof AudioMixerCounters; label: string }[] = [
  { key: "timestamp_discontinuities", label: "discont." },
  { key: "underruns", label: "underruns" },
  { key: "gaps_inserted", label: "gaps" },
  { key: "drops", label: "drops" },
  { key: "concealments", label: "conceal." },
  { key: "fade_ins", label: "fade ins" },
  { key: "fade_outs", label: "fade outs" },
];

const SECTIONS: Record<Section, SectionDef> = {
  bitrate: {
    label: "Bitrate",
    chip: "bitrate",
    fields: [
      { id: "video_1m", label: "video (1m avg)" },
      { id: "audio_1m", label: "audio (1m avg)" },
    ],
    unit: "kbps",
    metrics: [
      {
        id: "bitrate",
        label: "Bitrate (1s)",
        perTrack: true,
        aggregated: false,
        colors: ["#8884d8", "#82ca9d"],
      },
    ],
  },
  jitter: {
    label: "Jitter buffer",
    chip: "jitter",
    fields: [
      { id: "pkts", label: "pkts" },
      { id: "lost", label: "lost" },
      { id: "pkts_10s", label: "pkts (10s)" },
      { id: "lost_10s", label: "lost (10s)" },
    ],
    unit: "ms",
    metrics: [
      {
        id: "input_buffer",
        label: "Input buffer",
        perTrack: true,
        aggregated: true,
        colors: ["#a29bfe", "#6c5ce7"],
        defaultAggs: ["avg"],
      },
      {
        id: "effective_on_write",
        label: "Effective buffer on write",
        perTrack: true,
        aggregated: true,
        colors: ["#74b9ff", "#0984e3"],
        defaultAggs: ["min"],
      },
      {
        id: "effective_on_pop",
        label: "Effective buffer on pop",
        perTrack: true,
        aggregated: true,
        colors: ["#81ecec", "#00b894"],
        defaultAggs: ["min"],
      },
    ],
  },
  sync: {
    label: "Sync",
    chip: "sync",
    fields: [
      { id: "mode", label: "mode" },
      { id: "state", label: "state" },
      { id: "buffer", label: "FIFO buffer" },
      { id: "waiting_for_gap", label: "waiting for gap" },
      { id: "discont", label: "discont." },
      { id: "discont_10s", label: "discont. (10s)" },
    ],
    unit: "ms",
    metrics: [
      {
        id: "effective_on_receive",
        label: "Effective buffer on receive",
        perTrack: true,
        aggregated: true,
        colors: ["#74b9ff", "#0984e3"],
        defaultAggs: ["min"],
      },
      {
        id: "effective_on_output",
        label: "Effective buffer on output",
        perTrack: true,
        aggregated: true,
        colors: ["#81ecec", "#00b894"],
        defaultAggs: ["min"],
      },
      {
        // FIFO buffers are shown only as a field; jitter buffers are plotted because their size
        // reflects reordering and gap waits.
        id: "sync_buffer",
        label: "Jitter sync buffer",
        perTrack: true,
        aggregated: false,
        colors: ["#a29bfe", "#6c5ce7"],
      },
      {
        id: "target_offset",
        label: "Target offset distance",
        perTrack: true,
        aggregated: false,
        colors: ["#ffeaa7", "#e0a030"],
      },
      {
        id: "live_edge_lower",
        label: "Live edge (lower bound)",
        perTrack: true,
        aggregated: false,
        colors: ["#fab1a0", "#e17055"],
      },
      {
        id: "live_edge_upper",
        label: "Live edge (upper bound)",
        perTrack: true,
        aggregated: false,
        colors: ["#fd79a8", "#d05070"],
      },
      {
        id: "live_edge_recent_upper",
        label: "Live edge (recent upper bound)",
        perTrack: true,
        aggregated: false,
        colors: ["#f8a5e8", "#b04fa0"],
      },
    ],
  },
  mixer: {
    label: "Audio mixer",
    chip: "mixer",
    fields: [
      { id: "state", label: "state" },
      { id: "format", label: "format" },
      ...MIXER_COUNTERS.map((c) => ({
        id: c.key,
        label: c.label,
        children: [
          { id: "total", label: "total" },
          { id: "10s", label: "10s" },
        ],
      })),
    ],
    unit: "ms",
    metrics: [
      { id: "drift", label: "Drift", perTrack: false, aggregated: true, colors: "#e0a030" },
      {
        id: "input_buffer",
        label: "Input buffer",
        perTrack: false,
        aggregated: true,
        colors: "#82ca9d",
      },
    ],
  },
};

function inputSections(r: InputStatsReport): Section[] {
  const sections: Section[] = ["bitrate"];
  switch (r.type) {
    case "rtp":
    case "whip":
    case "whep":
      sections.push("jitter");
      break;
    case "hls":
    case "rtmp":
    case "moq_server":
    case "moq_client":
      sections.push("sync");
      break;
  }
  if (getInputMixer(r)) sections.push("mixer");
  return sections;
}

const OUTPUT_SECTIONS: Section[] = ["bitrate"];

// ── Chart series ────────────────────────────────────────────────────

/** One chart line. `id` is the leaf id in the display settings tree. */
interface SeriesDef {
  id: string;
  name: string;
  color: string;
  dash?: string;
  width: number;
}

const AGG_DASH: Record<Agg, string | undefined> = { avg: undefined, min: "2 4", max: "6 3" };

function metricSeries(section: Section, m: MetricDef): SeriesDef[] {
  const tracks = m.perTrack ? MEDIA_TRACKS : [null];
  const aggs = m.aggregated ? AGGS : [null];
  return tracks.flatMap((track) =>
    aggs.map((agg) => ({
      id: [section, "chart", m.id, track, agg].filter(Boolean).join("."),
      name:
        (track ? `${track === "video" ? "Video" : "Audio"} ${m.label}` : m.label) +
        (agg ? ` (${agg})` : ""),
      color: typeof m.colors === "string" ? m.colors : m.colors[track === "audio" ? 1 : 0],
      dash: agg ? AGG_DASH[agg] : undefined,
      width: agg && agg !== "avg" ? 1.5 : 2,
    })),
  );
}

const SERIES: Record<Section, SeriesDef[]> = {
  bitrate: SECTIONS.bitrate.metrics.flatMap((m) => metricSeries("bitrate", m)),
  jitter: SECTIONS.jitter.metrics.flatMap((m) => metricSeries("jitter", m)),
  sync: SECTIONS.sync.metrics.flatMap((m) => metricSeries("sync", m)),
  mixer: SECTIONS.mixer.metrics.flatMap((m) => metricSeries("mixer", m)),
};

/** Raw values (seconds, bits per second) keyed by series id. Missing keys mean "not applicable". */
type SeriesValues = Record<string, number>;

interface SeriesPoint {
  time: string;
  values: SeriesValues;
}

/**
 * Duration of the content held by the sync buffer for the chart, or `null` when it should not be
 * plotted (FIFO buffers are shown only as a field).
 */
function chartedSyncBufferSeconds(b: LiveSyncBuffer): number | null {
  switch (b.type) {
    case "fifo":
      return null;
    case "jitter":
      return b.duration_seconds;
  }
}

function inputSeriesValues(r: InputStatsReport): SeriesValues {
  const v: SeriesValues = {};
  for (const t of MEDIA_TRACKS) {
    const track = r[t];
    if (track) v[`bitrate.chart.bitrate.${t}`] = track.bitrate_1_second;
  }
  switch (r.type) {
    case "rtp":
    case "whip":
    case "whep":
      for (const t of MEDIA_TRACKS) {
        const w = r[t]?.jitter_buffer.last_10_seconds;
        if (!w) continue;
        for (const a of AGGS) {
          v[`jitter.chart.input_buffer.${t}.${a}`] = w[`input_buffer_${a}_seconds`];
          v[`jitter.chart.effective_on_write.${t}.${a}`] =
            w[`effective_buffer_on_write_${a}_seconds`];
          v[`jitter.chart.effective_on_pop.${t}.${a}`] = w[`effective_buffer_on_pop_${a}_seconds`];
        }
      }
      break;
    case "hls":
    case "rtmp":
    case "moq_server":
    case "moq_client":
      for (const t of MEDIA_TRACKS) {
        const s = r[t]?.sync;
        if (s?.mode !== "live") continue;
        const w = s.last_10_seconds;
        for (const a of AGGS) {
          v[`sync.chart.effective_on_receive.${t}.${a}`] =
            w[`effective_buffer_on_receive_${a}_seconds`];
          v[`sync.chart.effective_on_output.${t}.${a}`] =
            w[`effective_buffer_on_output_${a}_seconds`];
        }
        const optional: [string, number | null | undefined][] = [
          ["sync_buffer", chartedSyncBufferSeconds(s.buffer)],
          ["target_offset", s.target_offset_distance_seconds],
          ["live_edge_lower", s.live_edge_lower_bound_distance_seconds],
          ["live_edge_upper", s.live_edge_upper_bound_distance_seconds],
          ["live_edge_recent_upper", s.live_edge_recent_upper_bound_distance_seconds],
        ];
        for (const [metric, value] of optional) {
          if (value != null) v[`sync.chart.${metric}.${t}`] = value;
        }
      }
      break;
  }
  const mixer = getInputMixer(r);
  if (mixer) {
    const w = mixer.last_10_seconds;
    for (const a of AGGS) {
      v[`mixer.chart.drift.${a}`] = w[`drift_${a}_seconds`];
      v[`mixer.chart.input_buffer.${a}`] = w[`input_buffer_${a}_seconds`];
    }
  }
  return v;
}

function outputSeriesValues(r: OutputStatsReport): SeriesValues {
  return {
    "bitrate.chart.bitrate.video": r.video.bitrate_1_second,
    "bitrate.chart.bitrate.audio": r.audio.bitrate_1_second,
  };
}

const MAX_CHART_POINTS = 300;

// ── Display settings ────────────────────────────────────────────────

/**
 * Node of the display settings tree. Every node has its own switch and an item is shown only when
 * the switches of all its ancestors are on, so turning a group off keeps the choices inside it.
 * Ids are dot-separated paths, e.g. `sync.chart.effective_on_receive.video.min`.
 */
interface ToggleNode {
  id: string;
  label: string;
  defaultOn: boolean;
  children: ToggleNode[];
}

function fieldNodes(prefix: string, fields: FieldDef[]): ToggleNode[] {
  return fields.map((f) => {
    const id = `${prefix}.${f.id}`;
    return { id, label: f.label, defaultOn: true, children: fieldNodes(id, f.children ?? []) };
  });
}

function metricNode(prefix: string, m: MetricDef): ToggleNode {
  const id = `${prefix}.${m.id}`;
  const aggNodes = (parent: string): ToggleNode[] =>
    m.aggregated
      ? AGGS.map((a) => ({
          id: `${parent}.${a}`,
          label: a,
          defaultOn: m.defaultAggs?.includes(a) ?? true,
          children: [],
        }))
      : [];
  const children = m.perTrack
    ? MEDIA_TRACKS.map((t) => ({
        id: `${id}.${t}`,
        label: t,
        defaultOn: true,
        children: aggNodes(`${id}.${t}`),
      }))
    : aggNodes(id);
  return { id, label: m.label, defaultOn: true, children };
}

const SETTINGS_TREE: ToggleNode[] = ALL_SECTIONS.map((s) => {
  const def = SECTIONS[s];
  const children: ToggleNode[] = [];
  if (def.fields.length > 0) {
    children.push({
      id: `${s}.fields`,
      label: "Fields",
      defaultOn: true,
      children: fieldNodes(`${s}.fields`, def.fields),
    });
  }
  children.push({
    id: `${s}.chart`,
    label: "Chart",
    defaultOn: true,
    children: def.metrics.map((m) => metricNode(`${s}.chart`, m)),
  });
  return { id: s, label: def.label, defaultOn: true, children };
});

/** Switch state of every node in the settings tree, keyed by node id. */
type DisplaySettings = Record<string, boolean>;

function collectDefaults(nodes: ToggleNode[], out: DisplaySettings = {}): DisplaySettings {
  for (const n of nodes) {
    out[n.id] = n.defaultOn;
    collectDefaults(n.children, out);
  }
  return out;
}

const DEFAULT_SETTINGS = collectDefaults(SETTINGS_TREE);

function loadDisplaySettings(stored: unknown): DisplaySettings {
  const s = (typeof stored === "object" && stored !== null ? stored : {}) as Record<
    string,
    unknown
  >;
  const result = { ...DEFAULT_SETTINGS };
  for (const id of Object.keys(result)) {
    const v = s[id];
    if (typeof v === "boolean") result[id] = v;
  }
  return result;
}

/** Whether the node and all its ancestors are switched on. */
function isOn(settings: DisplaySettings, id: string): boolean {
  const parts = id.split(".");
  for (let i = 1; i <= parts.length; i++) {
    if (!settings[parts.slice(0, i).join(".")]) return false;
  }
  return true;
}

/** Per-card overrides. They can only hide what the global settings show. */
interface CardDisplay {
  collapsed?: boolean;
  hidden?: Section[];
}

/** Card overrides keyed by server URL, then by card key (`input:<id>` / `output:<id>`). */
type CardOverrides = Record<string, Record<string, CardDisplay>>;

function loadCardOverrides(stored: unknown): CardOverrides {
  return typeof stored === "object" && stored !== null ? (stored as CardOverrides) : {};
}

/** Whether a settings tree item is shown on a card, combining global settings and card overrides. */
function cardShows(settings: DisplaySettings, card: CardDisplay, id: string): boolean {
  const section = id.split(".")[0] as Section;
  return !card.collapsed && !card.hidden?.includes(section) && isOn(settings, id);
}

// ── Track fields ────────────────────────────────────────────────────

/**
 * Fields that come as a total and a 10s window pair are tagged with their variant; fields
 * without a 10s variant have none.
 */
type FieldVariant = "total" | "10s";

interface TrackField {
  /** Field path relative to `<section>.fields`. */
  id: string;
  name: string;
  value: string;
  variant?: FieldVariant;
}

/** One row of per-track details; values render in fixed-width cells so digit changes don't shift text. */
interface TrackInfo {
  section: Section;
  label: string;
  fields: TrackField[];
}

/**
 * Field groups in display order, each starting on its own line: fields without a 10s variant,
 * then totals, then their 10s variants (so a total and its 10s value share a column).
 */
const FIELD_GROUPS: (FieldVariant | undefined)[] = [undefined, "total", "10s"];

function bitrateTrackInfo(t: Tracks): TrackInfo {
  return {
    section: "bitrate",
    label: "1m avg",
    fields: [
      { id: "video_1m", name: "video", value: formatTrackBitrate(t.video) },
      { id: "audio_1m", name: "audio", value: formatTrackBitrate(t.audio) },
    ],
  };
}

function rtpTrackInfo(label: string, t: RtpJitterBuffer): TrackInfo {
  const w = t.last_10_seconds;
  return {
    section: "jitter",
    label,
    fields: [
      { id: "pkts", name: "pkts", value: String(t.packets_received), variant: "total" },
      { id: "lost", name: "lost", value: String(t.packets_lost), variant: "total" },
      {
        id: "pkts_10s",
        name: "pkts (10s)",
        value: String(w.packets_received),
        variant: "10s",
      },
      { id: "lost_10s", name: "lost (10s)", value: String(w.packets_lost), variant: "10s" },
    ],
  };
}

/** Jitter buffer duration is charted, so only the FIFO duration is shown as a field. */
function syncBufferFields(b: LiveSyncBuffer): TrackField[] {
  switch (b.type) {
    case "fifo":
      return [{ id: "buffer", name: "sync buffer", value: formatSeconds(b.duration_seconds) }];
    case "jitter":
      return [
        { id: "waiting_for_gap", name: "waiting for gap", value: b.waiting_for_gap ? "yes" : "no" },
      ];
  }
}

function syncTrackInfo(label: string, t: InputSyncTrack | null | undefined): TrackInfo {
  if (!t) {
    return {
      section: "sync",
      label,
      fields: [{ id: "mode", name: "mode", value: "not registered" }],
    };
  }
  if (t.mode === "simple") {
    return {
      section: "sync",
      label,
      fields: [
        { id: "mode", name: "mode", value: "simple" },
        { id: "state", name: "state", value: t.state },
      ],
    };
  }
  return {
    section: "sync",
    label,
    fields: [
      { id: "mode", name: "mode", value: "live" },
      { id: "state", name: "state", value: t.state },
      ...syncBufferFields(t.buffer),
      {
        id: "discont",
        name: "discont.",
        value: String(t.discontinuities_detected),
        variant: "total",
      },
      {
        id: "discont_10s",
        name: "discont. (10s)",
        value: String(t.last_10_seconds.discontinuities_detected),
        variant: "10s",
      },
    ],
  };
}

function mixerTrackInfo(label: string, m: AudioMixerInput): TrackInfo {
  const w = m.last_10_seconds;
  const format = m.input_format
    ? `${m.input_format.sample_rate / 1000} kHz ${m.input_format.channels}`
    : "n/a";
  return {
    section: "mixer",
    label,
    fields: [
      { id: "state", name: "state", value: m.state },
      { id: "format", name: "format", value: format },
      ...MIXER_COUNTERS.flatMap((c): TrackField[] => [
        { id: `${c.key}.total`, name: c.label, value: String(m[c.key]), variant: "total" },
        { id: `${c.key}.10s`, name: `${c.label} (10s)`, value: String(w[c.key]), variant: "10s" },
      ]),
    ],
  };
}

function inputTrackInfo(r: InputStatsReport): TrackInfo[] {
  const rows: TrackInfo[] = [bitrateTrackInfo(getInputTracks(r))];
  switch (r.type) {
    case "rtp":
    case "whip":
    case "whep":
      if (r.video) rows.push(rtpTrackInfo("Video", r.video.jitter_buffer));
      if (r.audio) rows.push(rtpTrackInfo("Audio", r.audio.jitter_buffer));
      break;
    case "hls":
    case "rtmp":
    case "moq_server":
    case "moq_client":
      rows.push(syncTrackInfo("Video", r.video?.sync), syncTrackInfo("Audio", r.audio?.sync));
      break;
  }
  const mixer = getInputMixer(r);
  if (mixer) rows.push(mixerTrackInfo("Mixer", mixer));
  return rows;
}

/** Keeps only the fields `show` accepts; rows left without fields are dropped. */
function visibleTrackInfo(rows: TrackInfo[], show: (id: string) => boolean): TrackInfo[] {
  return rows
    .map((row) => ({
      ...row,
      fields: row.fields.filter((f) => show(`${row.section}.fields.${f.id}`)),
    }))
    .filter((row) => row.fields.length > 0);
}

function TrackInfoTable({ rows }: { rows: TrackInfo[] }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ margin: "0.25rem 0 0.5rem" }}>
      {rows.map((row) => (
        <div key={`${row.section}:${row.label}`} style={trackRowStyle}>
          <div style={trackLabelStyle}>{row.label}</div>
          <div style={trackFieldGroupsStyle}>
            {FIELD_GROUPS.map((variant) => row.fields.filter((f) => f.variant === variant))
              .filter((group) => group.length > 0)
              .map((group) => (
                <div key={group[0].id} style={trackFieldGridStyle}>
                  {group.map((f) => (
                    <div key={f.id} style={trackFieldStyle}>
                      <span style={{ color: "var(--text-muted)" }}>{f.name}</span>
                      <span style={trackValueStyle}>{f.value}</span>
                    </div>
                  ))}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

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
};

const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const controlsRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem 1.25rem",
  flexWrap: "wrap",
  marginBottom: "1rem",
  fontSize: "0.85rem",
};

const smallButtonStyle: React.CSSProperties = {
  padding: "0.25rem 0.75rem",
  fontSize: "0.85rem",
};

const settingsPanelStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(26rem, 1fr))",
  gap: "0.75rem",
  marginBottom: "1rem",
};

const settingsSectionStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0.5rem 0.75rem",
  background: "var(--bg-surface)",
  fontSize: "0.85rem",
};

const TREE_INDENT = "1rem";

const toggleLabelStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  marginRight: "0.5rem",
  cursor: "pointer",
  whiteSpace: "nowrap",
  lineHeight: 1.7,
  // The label sits inside rows with a hanging indent; don't inherit it.
  textIndent: 0,
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

// Field groups (see `FIELD_GROUPS`) stack vertically, each in its own grid.
const trackFieldGroupsStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  rowGap: "2px",
};

// Fields live in uniform cells that wrap onto more lines when the card is narrow and stretch to
// fill the row. Wrapping depends only on the card width, never on the values, so positions stay
// stable. All group grids of a row have the same width, so their columns line up.
const trackFieldGridStyle: React.CSSProperties = {
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

const chartTitleStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  fontWeight: 600,
  margin: "0.75rem 0 0.25rem",
  color: "var(--text-muted)",
};

const statRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "2rem",
  flexWrap: "wrap",
  margin: "0.5rem 0",
  fontSize: "0.9rem",
};

// ── Small components ────────────────────────────────────────────────

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

/** Toggle button; struck through when off. */
function Chip({
  label,
  active,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      style={{
        padding: "1px 8px",
        fontSize: "0.8rem",
        border: "1px solid var(--border)",
        background: active ? "var(--badge-bg)" : "transparent",
        color: active ? "var(--text)" : "var(--text-dim)",
        textDecoration: active ? "none" : "line-through",
      }}
    >
      {label}
    </button>
  );
}

/** Card title with a collapse toggle and chips for hiding the card's sections. */
function CardHeader({
  id,
  type,
  sections,
  card,
  onChange,
}: {
  id: string;
  type: string;
  /** Sections the card has that are enabled globally. */
  sections: Section[];
  card: CardDisplay;
  onChange: (card: CardDisplay) => void;
}) {
  const hidden = card.hidden ?? [];
  const toggleSection = (s: Section) =>
    onChange({
      ...card,
      hidden: hidden.includes(s) ? hidden.filter((h) => h !== s) : [...hidden, s],
    });
  return (
    <div style={cardHeaderStyle}>
      <button
        type="button"
        onClick={() => onChange({ ...card, collapsed: !card.collapsed })}
        title={card.collapsed ? "Expand" : "Collapse"}
        style={{ padding: "0 6px", fontSize: "0.8rem", lineHeight: 1.5 }}
      >
        {card.collapsed ? "▸" : "▾"}
      </button>
      <strong>{id}</strong>
      <span style={badgeStyle}>{type}</span>
      {!card.collapsed && sections.length > 0 && (
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
          {sections.map((s) => (
            <Chip
              key={s}
              label={SECTIONS[s].chip}
              active={!hidden.includes(s)}
              onClick={() => toggleSection(s)}
              title={`Show ${SECTIONS[s].label.toLowerCase()} on this card`}
            />
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * Checkbox for a settings node and its subtree. Nodes whose children are all leaves render on one
 * line (e.g. `video: avg min max`); deeper nodes nest their children below. Children of a node
 * that is off are dimmed but stay editable.
 */
function ToggleTreeNode({
  node,
  settings,
  onToggle,
  bold,
}: {
  node: ToggleNode;
  settings: DisplaySettings;
  onToggle: (id: string) => void;
  bold?: boolean;
}) {
  const on = settings[node.id];
  const inline = node.children.length > 0 && node.children.every((c) => c.children.length === 0);
  const box = (
    <label style={{ ...toggleLabelStyle, fontWeight: bold ? 600 : undefined }}>
      <input type="checkbox" checked={on} onChange={() => onToggle(node.id)} />
      {inline ? `${node.label}:` : node.label}
    </label>
  );
  if (node.children.length === 0) return box;
  const children = node.children.map((c) => (
    <ToggleTreeNode key={c.id} node={c} settings={settings} onToggle={onToggle} />
  ));
  if (inline) {
    // Hanging indent: options that wrap continue one level deeper than the label, so they don't
    // read as siblings of it.
    return (
      <div style={{ paddingLeft: TREE_INDENT, textIndent: `-${TREE_INDENT}` }}>
        {box}
        <span style={{ opacity: on ? 1 : 0.45 }}>{children}</span>
      </div>
    );
  }
  return (
    <div>
      {box}
      <div style={{ paddingLeft: TREE_INDENT, opacity: on ? 1 : 0.45 }}>{children}</div>
    </div>
  );
}

/** Section heading with the section's fields and chart below it; nothing when both are empty. */
function SectionBlock({
  section,
  rows,
  series,
  data,
}: {
  section: Section;
  rows: TrackInfo[];
  series: SeriesDef[];
  data: SeriesPoint[];
}) {
  const lines = series.filter((s) => data.some((d) => Number.isFinite(d.values[s.id])));
  if (rows.length === 0 && lines.length === 0) return null;
  return (
    <>
      <div style={chartTitleStyle}>{SECTIONS[section].label}</div>
      <TrackInfoTable rows={rows} />
      {lines.length > 0 && <SeriesChart unit={SECTIONS[section].unit} lines={lines} data={data} />}
    </>
  );
}

function SeriesChart({
  unit,
  lines,
  data,
}: {
  unit: Unit;
  /** Series to draw; all of them have data. */
  lines: SeriesDef[];
  data: SeriesPoint[];
}) {
  // Values are stored in seconds and bits per second.
  const scale = unit === "ms" ? 1000 : 1 / 1000;

  return (
    <>
      <ResponsiveContainer width="100%" height={230}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="time"
            tick={{ fontSize: 11, fill: "var(--text-muted)" }}
            interval="preserveStartEnd"
            stroke="var(--border)"
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--text-muted)" }}
            unit={` ${unit}`}
            width={80}
            stroke="var(--border)"
          />
          <Tooltip
            formatter={(v: number) => `${v.toFixed(1)} ${unit}`}
            contentStyle={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text)",
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {lines.map((s) => (
            <Line
              key={s.id}
              type="monotone"
              dataKey={(d: SeriesPoint) => {
                const v = d.values[s.id];
                return v === undefined ? null : v * scale;
              }}
              name={s.name}
              stroke={s.color}
              strokeWidth={s.width}
              strokeDasharray={s.dash}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

// ── Component ───────────────────────────────────────────────────────

export const meta: ToolMeta = {
  id: "smelter-stats",
  name: "Smelter Stats",
  description: "Real-time statistics dashboard",
  scrollable: true,
};

export default function SmelterStats({ params }: { params: URLSearchParams }) {
  const [url, setUrl] = useSessionInput("stats:url", params, "url", "http://localhost:8081");
  const [status, setStatus] = useState<string | null>(null);
  const [report, setReport] = useState<StatsReport | null>(null);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useSessionInput("stats:filter", params, "filter");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useLocalStorageState(
    "stats:display-settings",
    loadDisplaySettings,
  );
  const [cardOverrides, setCardOverrides] = useLocalStorageState(
    "stats:card-overrides",
    loadCardOverrides,
  );

  const toggleSetting = (id: string) => setSettings((prev) => ({ ...prev, [id]: !prev[id] }));

  const serverKey = url.replace(/\/$/, "");
  const serverOverrides = cardOverrides[serverKey] ?? {};
  const updateCards = (keys: string[], update: (card: CardDisplay) => CardDisplay) =>
    setCardOverrides((prev) => {
      const server = { ...prev[serverKey] };
      for (const key of keys) server[key] = update(server[key] ?? {});
      return { ...prev, [serverKey]: server };
    });
  const setAllCollapsed = (collapsed: boolean) => {
    if (!report) return;
    const keys = [
      ...Object.keys(report.inputs).map((id) => `input:${id}`),
      ...Object.keys(report.outputs).map((id) => `output:${id}`),
    ];
    updateCards(keys, (card) => ({ ...card, collapsed }));
  };
  const resetOverrides = () => setCardOverrides((prev) => ({ ...prev, [serverKey]: {} }));

  // Accumulated chart values per card key (`input:<id>` / `output:<id>`)
  const historyRef = useRef<Record<string, SeriesPoint[]>>({});

  const fetchStats = useCallback(async () => {
    if (!url) return;
    try {
      const resp = await fetch(`${url.replace(/\/$/, "")}/stats`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: StatsReport = await resp.json();
      setReport(data);
      setStatus(null);

      const time = new Date().toLocaleTimeString();
      const push = (key: string, values: SeriesValues) => {
        const prev = historyRef.current[key] ?? [];
        historyRef.current[key] = [...prev.slice(-(MAX_CHART_POINTS - 1)), { time, values }];
      };
      for (const [id, input] of Object.entries(data.inputs)) {
        push(`input:${id}`, inputSeriesValues(input));
      }
      for (const [id, output] of Object.entries(data.outputs)) {
        push(`output:${id}`, outputSeriesValues(output));
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
    saveToHistory("stats:url", url);
    setRunning(true);
  }, [url]);

  /**
   * Card header and general status, then one block per section with its fields and chart, all
   * filtered by the display settings.
   */
  const renderCard = (
    key: string,
    id: string,
    type: string,
    sections: Section[],
    status: React.ReactNode[],
    trackInfo: TrackInfo[],
  ) => {
    const card = serverOverrides[key] ?? {};
    const show = (itemId: string) => cardShows(settings, card, itemId);
    const history = historyRef.current[key] ?? [];
    const rows = visibleTrackInfo(trackInfo, show);
    return (
      <div key={key} style={cardStyle}>
        <CardHeader
          id={id}
          type={type}
          sections={sections.filter((s) => settings[s])}
          card={card}
          onChange={(c) => updateCards([key], () => c)}
        />
        {!card.collapsed && (
          <>
            {status.length > 0 && <div style={statRowStyle}>{status}</div>}
            {sections.map((s) => (
              <SectionBlock
                key={s}
                section={s}
                rows={rows.filter((r) => r.section === s)}
                series={SERIES[s].filter((series) => show(series.id))}
                data={history}
              />
            ))}
          </>
        )}
      </div>
    );
  };

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
        <div style={controlsRowStyle}>
          <button style={smallButtonStyle} onClick={() => setSettingsOpen((o) => !o)}>
            Display settings {settingsOpen ? "▾" : "▸"}
          </button>
          <span style={{ display: "inline-flex", gap: 4 }}>
            {ALL_SECTIONS.map((s) => (
              <Chip
                key={s}
                label={SECTIONS[s].chip}
                active={settings[s]}
                onClick={() => toggleSetting(s)}
                title={`Show ${SECTIONS[s].label.toLowerCase()} on all cards`}
              />
            ))}
          </span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by id or type"
            style={{ padding: "0.25rem 0.5rem", fontSize: "0.85rem", width: "12rem" }}
          />
          <span style={{ display: "inline-flex", gap: 4 }}>
            <button style={smallButtonStyle} onClick={() => setAllCollapsed(true)}>
              Collapse all
            </button>
            <button style={smallButtonStyle} onClick={() => setAllCollapsed(false)}>
              Expand all
            </button>
            <button
              style={smallButtonStyle}
              onClick={resetOverrides}
              title="Clear per-card collapse and section choices for this server"
            >
              Reset cards
            </button>
          </span>
        </div>
      )}

      {report && settingsOpen && (
        <>
          <div style={settingsPanelStyle}>
            {SETTINGS_TREE.map((node) => (
              <div key={node.id} style={settingsSectionStyle}>
                <ToggleTreeNode node={node} settings={settings} onToggle={toggleSetting} bold />
              </div>
            ))}
          </div>
          <div style={{ ...controlsRowStyle, marginTop: "-0.25rem" }}>
            <button style={smallButtonStyle} onClick={() => setSettings(() => DEFAULT_SETTINGS)}>
              Reset display settings
            </button>
          </div>
        </>
      )}

      {report &&
        (() => {
          const inputs = Object.entries(report.inputs).filter(([id, input]) =>
            matchesFilter(filter, id, input.type),
          );
          const outputs = Object.entries(report.outputs).filter(([id, output]) =>
            matchesFilter(filter, id, output.type),
          );
          const registered = Object.keys(report.inputs).length + Object.keys(report.outputs).length;
          return (
            <>
              {inputs.length > 0 && (
                <>
                  <h2 style={{ fontSize: "1.1rem", margin: "1.5rem 0 0.5rem" }}>Inputs</h2>
                  {inputs.map(([id, input]) =>
                    renderCard(
                      `input:${id}`,
                      id,
                      input.type,
                      inputSections(input),
                      "is_connected" in input
                        ? [<ConnectionIndicator key="conn" connected={input.is_connected} />]
                        : [],
                      inputTrackInfo(input),
                    ),
                  )}
                </>
              )}

              {outputs.length > 0 && (
                <>
                  <h2 style={{ fontSize: "1.1rem", margin: "1.5rem 0 0.5rem" }}>Outputs</h2>
                  {outputs.map(([id, output]) =>
                    renderCard(
                      `output:${id}`,
                      id,
                      output.type,
                      OUTPUT_SECTIONS,
                      [
                        ...("is_connected" in output
                          ? [<ConnectionIndicator key="conn" connected={output.is_connected} />]
                          : []),
                        ...outputExtraInfo(output).map((e, i) => (
                          <span key={i} style={{ color: "var(--text-muted)" }}>
                            {e}
                          </span>
                        )),
                      ],
                      [bitrateTrackInfo(getOutputTracks(output))],
                    ),
                  )}
                </>
              )}

              {registered === 0 && (
                <p style={{ color: "var(--text-muted)" }}>No inputs or outputs registered.</p>
              )}
              {registered > 0 && inputs.length === 0 && outputs.length === 0 && (
                <p style={{ color: "var(--text-muted)" }}>No inputs or outputs match the filter.</p>
              )}
            </>
          );
        })()}
    </>
  );
}
