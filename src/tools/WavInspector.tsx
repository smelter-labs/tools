import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from "react";

interface WavData {
  fileName: string;
  fileSize: number;
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  format: string; // PCM, IEEE Float, etc.
  durationSeconds: number;
  totalFrames: number;
  // Samples normalized to [-1, 1], one Float32Array per channel.
  channels: Float32Array[];
}

class WavParseError extends Error {}

function readString(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

function parseWav(buf: ArrayBuffer, fileName: string): WavData {
  const view = new DataView(buf);
  if (buf.byteLength < 44) throw new WavParseError("File too small to be a WAV.");
  const riff = readString(view, 0, 4);
  if (riff !== "RIFF" && riff !== "RIFX" && riff !== "RF64") {
    throw new WavParseError(`Not a RIFF file (got "${riff}").`);
  }
  const littleEndian = riff !== "RIFX";
  const wave = readString(view, 8, 4);
  if (wave !== "WAVE") throw new WavParseError(`Not a WAVE file (got "${wave}").`);

  let formatCode = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  let pos = 12;
  while (pos + 8 <= buf.byteLength) {
    const id = readString(view, pos, 4);
    const size = view.getUint32(pos + 4, littleEndian);
    const chunkStart = pos + 8;
    if (id === "fmt ") {
      formatCode = view.getUint16(chunkStart, littleEndian);
      numChannels = view.getUint16(chunkStart + 2, littleEndian);
      sampleRate = view.getUint32(chunkStart + 4, littleEndian);
      bitsPerSample = view.getUint16(chunkStart + 14, littleEndian);
      if (formatCode === 0xfffe && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE — read actual format from GUID first 2 bytes.
        const subFormat = view.getUint16(chunkStart + 24, littleEndian);
        formatCode = subFormat;
      }
    } else if (id === "data") {
      dataOffset = chunkStart;
      dataSize = size;
      break;
    }
    pos = chunkStart + size + (size & 1); // chunks padded to even size
  }

  if (dataOffset < 0) throw new WavParseError("No data chunk found.");
  if (numChannels === 0 || sampleRate === 0 || bitsPerSample === 0) {
    throw new WavParseError("Missing fmt chunk.");
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameSize = bytesPerSample * numChannels;
  const totalFrames = Math.floor(Math.min(dataSize, buf.byteLength - dataOffset) / frameSize);
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(totalFrames));

  const isFloat = formatCode === 3;
  const isPcm = formatCode === 1;
  if (!isFloat && !isPcm) {
    throw new WavParseError(
      `Unsupported format code 0x${formatCode.toString(16)} (only PCM and IEEE float are supported).`,
    );
  }

  let formatLabel: string;
  if (isFloat) formatLabel = `IEEE Float ${bitsPerSample}-bit`;
  else formatLabel = `PCM ${bitsPerSample}-bit`;

  for (let f = 0; f < totalFrames; f++) {
    const frameOffset = dataOffset + f * frameSize;
    for (let c = 0; c < numChannels; c++) {
      const s = frameOffset + c * bytesPerSample;
      let v: number;
      if (isFloat) {
        if (bitsPerSample === 32) v = view.getFloat32(s, littleEndian);
        else if (bitsPerSample === 64) v = view.getFloat64(s, littleEndian);
        else throw new WavParseError(`Unsupported float bit depth ${bitsPerSample}.`);
      } else {
        if (bitsPerSample === 8) {
          v = (view.getUint8(s) - 128) / 128;
        } else if (bitsPerSample === 16) {
          v = view.getInt16(s, littleEndian) / 32768;
        } else if (bitsPerSample === 24) {
          const b0 = view.getUint8(s);
          const b1 = view.getUint8(s + 1);
          const b2 = view.getUint8(s + 2);
          let raw = littleEndian ? (b2 << 16) | (b1 << 8) | b0 : (b0 << 16) | (b1 << 8) | b2;
          if (raw & 0x800000) raw |= 0xff000000;
          v = raw / 8388608;
        } else if (bitsPerSample === 32) {
          v = view.getInt32(s, littleEndian) / 2147483648;
        } else {
          throw new WavParseError(`Unsupported PCM bit depth ${bitsPerSample}.`);
        }
      }
      channels[c][f] = v;
    }
  }

  return {
    fileName,
    fileSize: buf.byteLength,
    sampleRate,
    numChannels,
    bitsPerSample,
    format: formatLabel,
    durationSeconds: totalFrames / sampleRate,
    totalFrames,
    channels,
  };
}

interface ViewState {
  // Visible range in frames at the highest sample rate among loaded files.
  start: number;
  end: number;
}

const COLORS = ["#f24664", "#46c8f2"];

function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return "—";
  const sign = seconds < 0 ? "-" : "";
  const abs = Math.abs(seconds);
  const mins = Math.floor(abs / 60);
  const secs = abs - mins * 60;
  if (mins > 0) return `${sign}${mins}:${secs.toFixed(5).padStart(8, "0")}`;
  return `${sign}${secs.toFixed(5)}s`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

interface WaveformProps {
  wav: WavData;
  view: ViewState; // in seconds (we use seconds across files for shared view)
  maxDuration: number; // upper bound for clamping the view (may exceed this wav's own length)
  timeOffset: number; // seconds to shift this wav along the display timeline
  color: string;
  height: number;
  cursorSeconds: number | null;
  onCursorChange: (s: number | null) => void;
  onViewChange: (next: ViewState) => void;
}

function Waveform({
  wav,
  view,
  maxDuration,
  timeOffset,
  color,
  height,
  cursorSeconds,
  onCursorChange,
  onViewChange,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Background.
    ctx.fillStyle = "#0e0b1c";
    ctx.fillRect(0, 0, width, height);

    const channels = wav.channels;
    const numCh = channels.length;
    const chHeight = height / numCh;

    const span = view.end - view.start;
    const secondsPerPixel = span / width;
    const framesPerPixel = secondsPerPixel * wav.sampleRate;
    const pxPerFrame = 1 / framesPerPixel;
    const timeToX = (t: number) => ((t - view.start) / span) * width;

    // Pixel range over which this wav has data (rest of the canvas stays empty,
    // so files of different durations align in absolute time).
    const xDataStart = Math.max(0, timeToX(timeOffset));
    const xDataEnd = Math.min(width, timeToX(timeOffset + wav.durationSeconds));

    for (let c = 0; c < numCh; c++) {
      const cy = c * chHeight + chHeight / 2;
      // Zero line — only over the wav's actual time range.
      ctx.strokeStyle = "#332a52";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xDataStart, cy);
      ctx.lineTo(xDataEnd, cy);
      ctx.stroke();

      const data = channels[c];
      ctx.strokeStyle = color;
      ctx.fillStyle = color;

      if (framesPerPixel >= 2) {
        // Min/max envelope per pixel.
        ctx.beginPath();
        const xLo = Math.max(0, Math.floor(xDataStart));
        const xHi = Math.min(width, Math.ceil(xDataEnd));
        for (let x = xLo; x < xHi; x++) {
          const t0 = view.start + x * secondsPerPixel;
          const t1 = t0 + secondsPerPixel;
          const f0 = Math.max(0, Math.floor((t0 - timeOffset) * wav.sampleRate));
          const f1 = Math.min(wav.totalFrames, Math.floor((t1 - timeOffset) * wav.sampleRate) + 1);
          if (f1 <= f0) continue;
          let mn = Infinity;
          let mx = -Infinity;
          for (let i = f0; i < f1; i++) {
            const v = data[i];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          if (mn === Infinity) continue;
          const yMin = cy - mn * (chHeight / 2 - 2);
          const yMax = cy - mx * (chHeight / 2 - 2);
          ctx.moveTo(x + 0.5, yMin);
          ctx.lineTo(x + 0.5, yMax);
        }
        ctx.stroke();
      } else {
        // Per-sample line, with dots when very zoomed in.
        const f0 = Math.max(0, Math.floor((view.start - timeOffset) * wav.sampleRate));
        const f1 = Math.min(
          wav.totalFrames - 1,
          Math.ceil((view.end - timeOffset) * wav.sampleRate),
        );
        if (f1 >= f0) {
          ctx.beginPath();
          for (let i = f0; i <= f1; i++) {
            const x = timeToX(i / wav.sampleRate + timeOffset);
            const y = cy - data[i] * (chHeight / 2 - 2);
            if (i === f0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
          if (pxPerFrame >= 6) {
            for (let i = f0; i <= f1; i++) {
              const x = timeToX(i / wav.sampleRate + timeOffset);
              const y = cy - data[i] * (chHeight / 2 - 2);
              ctx.beginPath();
              ctx.arc(x, y, 2, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }

      // Channel divider.
      if (c > 0) {
        ctx.strokeStyle = "#1e1835";
        ctx.beginPath();
        ctx.moveTo(0, c * chHeight);
        ctx.lineTo(width, c * chHeight);
        ctx.stroke();
      }
    }

    // Faint marker at the wav's end if it falls within the view.
    if (xDataEnd > 0 && xDataEnd < width) {
      ctx.strokeStyle = "#332a52";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(xDataEnd + 0.5, 0);
      ctx.lineTo(xDataEnd + 0.5, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Cursor.
    if (cursorSeconds !== null && cursorSeconds >= view.start && cursorSeconds <= view.end) {
      const x = ((cursorSeconds - view.start) / (view.end - view.start)) * width;
      ctx.strokeStyle = "#fcf5f5";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    }
  }, [wav, view, width, height, color, cursorSeconds, timeOffset]);

  useEffect(() => {
    draw();
  }, [draw]);

  const dragRef = useRef<{ startX: number; startView: ViewState; rectWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const clampView = useCallback(
    (start: number, end: number): ViewState => {
      const span = end - start;
      if (start < 0) {
        start = 0;
        end = span;
      }
      if (end > maxDuration) {
        end = maxDuration;
        start = Math.max(0, end - span);
      }
      return { start, end };
    },
    [maxDuration],
  );

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frac = x / rect.width;
    const span = view.end - view.start;
    if (e.shiftKey) {
      // Pan with shift+wheel.
      const delta = (e.deltaY / rect.width) * span;
      onViewChange(clampView(view.start + delta, view.end + delta));
    } else {
      // Zoom around cursor (default).
      const factor = Math.pow(1.0015, e.deltaY);
      const newSpan = Math.max(1 / wav.sampleRate, Math.min(maxDuration, span * factor));
      const anchor = view.start + frac * span;
      onViewChange(clampView(anchor - frac * newSpan, anchor - frac * newSpan + newSpan));
    }
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    dragRef.current = { startX: e.clientX, startView: view, rectWidth: rect.width };
    setDragging(true);
    e.preventDefault();
  };

  // Bind document-level listeners while dragging so the gesture works even when
  // the mouse leaves the canvas.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const span = d.startView.end - d.startView.start;
      const dx = e.clientX - d.startX;
      const delta = -(dx / d.rectWidth) * span;
      onViewChange(clampView(d.startView.start + delta, d.startView.end + delta));
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, clampView, onViewChange]);

  const onMouseMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frac = x / rect.width;
    onCursorChange(view.start + frac * (view.end - view.start));
  };

  const onMouseLeave = () => {
    if (!dragging) onCursorChange(null);
  };

  return (
    <div
      ref={containerRef}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      style={{
        width: "100%",
        height,
        border: "1px solid var(--border)",
        borderRadius: 4,
        cursor: dragging ? "grabbing" : "grab",
        overflow: "hidden",
        userSelect: "none",
      }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );
}

interface FileSlotProps {
  label: string;
  wav: WavData | null;
  error: string | null;
  loading: boolean;
  onFile: (file: File) => void;
  onClear: () => void;
}

function FileSlot({ label, wav, error, loading, onFile, onClear }: FileSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      style={{
        border: `1px dashed ${drag ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 8,
        padding: "0.75rem 1rem",
        background: drag ? "var(--bg-hover)" : "var(--bg-surface)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <strong style={{ minWidth: 60 }}>{label}</strong>
        <input
          ref={inputRef}
          type="file"
          accept=".wav,audio/wav,audio/x-wav,audio/wave"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
        <button onClick={() => inputRef.current?.click()}>Choose file…</button>
        {wav && <button onClick={onClear}>Clear</button>}
        {loading && <span style={{ color: "var(--text-muted)" }}>Loading…</span>}
        {wav && (
          <span style={{ color: "var(--text-muted)", fontFamily: "monospace" }}>
            {wav.fileName}
          </span>
        )}
      </div>
      {error && <div style={{ color: "var(--error)", marginTop: "0.5rem" }}>{error}</div>}
      {wav && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
            gap: "0.25rem 1rem",
            marginTop: "0.5rem",
            fontSize: "0.85rem",
            color: "var(--text-muted)",
          }}
        >
          <Field k="Format" v={wav.format} />
          <Field k="Sample rate" v={`${wav.sampleRate.toLocaleString()} Hz`} />
          <Field k="Channels" v={String(wav.numChannels)} />
          <Field k="Duration" v={formatTime(wav.durationSeconds)} />
          <Field k="Frames" v={wav.totalFrames.toLocaleString()} />
          <Field k="File size" v={formatBytes(wav.fileSize)} />
        </div>
      )}
    </div>
  );
}

function Field({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div>
      <span style={{ color: "var(--text-dim)" }}>{k}: </span>
      <span style={{ color: "var(--text)", fontFamily: "monospace" }}>{v}</span>
    </div>
  );
}

interface SlotState {
  wav: WavData | null;
  error: string | null;
  loading: boolean;
}

const EMPTY_SLOT: SlotState = { wav: null, error: null, loading: false };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function WavInspector(_props: { params: URLSearchParams }) {
  const [slotA, setSlotA] = useState<SlotState>(EMPTY_SLOT);
  const [slotB, setSlotB] = useState<SlotState>(EMPTY_SLOT);
  const [view, setView] = useState<ViewState>({ start: 0, end: 1 });
  const [cursor, setCursor] = useState<number | null>(null);
  const [linkView, setLinkView] = useState(true);
  const [viewB, setViewB] = useState<ViewState>({ start: 0, end: 1 });
  const [offsetB, setOffsetB] = useState(0);
  const [offsetBText, setOffsetBText] = useState("0");

  const loadFile = async (file: File, slot: "A" | "B") => {
    const setter = slot === "A" ? setSlotA : setSlotB;
    const otherWav = slot === "A" ? slotB.wav : slotA.wav;
    setter({ wav: null, error: null, loading: true });
    try {
      const buf = await file.arrayBuffer();
      const wav = parseWav(buf, file.name);
      setter({ wav, error: null, loading: false });
      const dur = Math.max(wav.durationSeconds, otherWav?.durationSeconds ?? 0);
      setView({ start: 0, end: dur });
      setViewB({ start: 0, end: dur });
      return wav;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setter({ wav: null, error: msg, loading: false });
      return null;
    }
  };

  const linkedMaxDuration = Math.max(
    slotA.wav?.durationSeconds ?? 0,
    (slotB.wav?.durationSeconds ?? 0) + offsetB,
  );

  const playRef = useRef<{ ctx: AudioContext; src: AudioBufferSourceNode } | null>(null);

  const stopPlayback = useCallback(() => {
    if (playRef.current) {
      try {
        playRef.current.src.stop();
      } catch {
        /* already stopped */
      }
      playRef.current.ctx.close();
      playRef.current = null;
    }
  }, []);

  useEffect(() => stopPlayback, [stopPlayback]);

  const playSlot = useCallback(
    (wav: WavData, fromSeconds: number) => {
      stopPlayback();
      const ctx = new AudioContext({ sampleRate: wav.sampleRate });
      const audioBuf = ctx.createBuffer(wav.numChannels, wav.totalFrames, wav.sampleRate);
      for (let c = 0; c < wav.numChannels; c++) audioBuf.copyToChannel(wav.channels[c], c);
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(ctx.destination);
      src.start(0, Math.max(0, fromSeconds));
      src.onended = () => {
        if (playRef.current?.src === src) {
          ctx.close();
          playRef.current = null;
        }
      };
      playRef.current = { ctx, src };
    },
    [stopPlayback],
  );

  const resetZoom = () => {
    const a = slotA.wav?.durationSeconds ?? 0;
    const b = slotB.wav?.durationSeconds ?? 0;
    const max = Math.max(a, b);
    if (max > 0) {
      setView({ start: 0, end: max });
      setViewB({ start: 0, end: max });
    }
  };

  const cursorInfo = useMemo(() => {
    if (cursor === null) return null;
    const sample = (wav: WavData | null, offset: number) => {
      if (!wav) return null;
      const idx = Math.round((cursor - offset) * wav.sampleRate);
      if (idx < 0 || idx >= wav.totalFrames) return null;
      return { idx, values: wav.channels.map((c) => c[idx]) };
    };
    return { time: cursor, a: sample(slotA.wav, 0), b: sample(slotB.wav, offsetB) };
  }, [cursor, slotA.wav, slotB.wav, offsetB]);

  const onViewChangeA = (v: ViewState) => {
    setView(v);
    if (linkView) setViewB(v);
  };
  const onViewChangeB = (v: ViewState) => {
    setViewB(v);
    if (linkView) setView(v);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        flex: 1,
        minHeight: 0,
        overflow: "auto",
      }}
    >
      <p style={{ margin: 0, color: "var(--text-muted)" }}>
        Drop a .wav file (or two for comparison). Scroll to zoom around the cursor, drag to pan,
        shift+scroll also pans. Zoom in to see individual samples.
      </p>

      <FileSlot
        label="File A"
        wav={slotA.wav}
        error={slotA.error}
        loading={slotA.loading}
        onFile={(f) => loadFile(f, "A")}
        onClear={() => setSlotA(EMPTY_SLOT)}
      />
      <FileSlot
        label="File B"
        wav={slotB.wav}
        error={slotB.error}
        loading={slotB.loading}
        onFile={(f) => loadFile(f, "B")}
        onClear={() => setSlotB(EMPTY_SLOT)}
      />

      {(slotA.wav || slotB.wav) && (
        <>
          <div
            style={{
              display: "flex",
              gap: "1rem",
              alignItems: "center",
              flexWrap: "wrap",
              fontSize: "0.9rem",
            }}
          >
            <button onClick={resetZoom}>Reset zoom</button>
            {slotA.wav && slotB.wav && (
              <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <input
                  type="checkbox"
                  checked={linkView}
                  onChange={(e) => {
                    setLinkView(e.target.checked);
                    if (e.target.checked) setViewB(view);
                  }}
                />
                Link zoom &amp; pan
              </label>
            )}
            {slotA.wav && slotB.wav && (
              <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                B offset (s):
                <input
                  type="number"
                  step="0.00001"
                  value={offsetBText}
                  onChange={(e) => {
                    setOffsetBText(e.target.value);
                    const n = parseFloat(e.target.value);
                    if (Number.isFinite(n)) setOffsetB(n);
                  }}
                  style={{ width: "16ch", padding: "0.2rem 0.4rem", fontFamily: "monospace" }}
                />
                {slotB.wav && (
                  <span style={{ color: "var(--text-dim)", fontFamily: "monospace" }}>
                    ({Math.round(offsetB * slotB.wav.sampleRate)} samples @ {slotB.wav.sampleRate}{" "}
                    Hz)
                  </span>
                )}
              </label>
            )}
            <span style={{ color: "var(--text-muted)" }}>
              View: {formatTime(view.start)} – {formatTime(view.end)} (
              {formatTime(view.end - view.start)})
            </span>
            {cursorInfo && (
              <span style={{ color: "var(--text-muted)", fontFamily: "monospace" }}>
                t={formatTime(cursorInfo.time)}
                {cursorInfo.a &&
                  ` · A[${cursorInfo.a.idx}]=${cursorInfo.a.values.map((v) => v.toFixed(5)).join(", ")}`}
                {cursorInfo.b &&
                  ` · B[${cursorInfo.b.idx}]=${cursorInfo.b.values.map((v) => v.toFixed(5)).join(", ")}`}
              </span>
            )}
          </div>

          {slotA.wav && (
            <SlotPlayer
              label="A"
              wav={slotA.wav}
              color={COLORS[0]}
              view={view}
              maxDuration={linkView ? linkedMaxDuration : slotA.wav.durationSeconds}
              timeOffset={0}
              cursor={cursor}
              onCursor={setCursor}
              onViewChange={onViewChangeA}
              onPlay={() => playSlot(slotA.wav!, cursor ?? view.start)}
              onStop={stopPlayback}
            />
          )}
          {slotB.wav && (
            <SlotPlayer
              label="B"
              wav={slotB.wav}
              color={COLORS[1]}
              view={linkView ? view : viewB}
              maxDuration={
                linkView ? linkedMaxDuration : slotB.wav.durationSeconds + Math.max(0, offsetB)
              }
              timeOffset={offsetB}
              cursor={cursor}
              onCursor={setCursor}
              onViewChange={onViewChangeB}
              onPlay={() =>
                playSlot(
                  slotB.wav!,
                  Math.max(0, (cursor ?? (linkView ? view.start : viewB.start)) - offsetB),
                )
              }
              onStop={stopPlayback}
            />
          )}

          {slotA.wav && slotB.wav && <DiffSummary a={slotA.wav} b={slotB.wav} offsetB={offsetB} />}
        </>
      )}
    </div>
  );
}

function SlotPlayer({
  label,
  wav,
  color,
  view,
  maxDuration,
  timeOffset,
  cursor,
  onCursor,
  onViewChange,
  onPlay,
  onStop,
}: {
  label: string;
  wav: WavData;
  color: string;
  view: ViewState;
  maxDuration: number;
  timeOffset: number;
  cursor: number | null;
  onCursor: (s: number | null) => void;
  onViewChange: (v: ViewState) => void;
  onPlay: () => void;
  onStop: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      <div
        style={{
          display: "flex",
          gap: "0.6rem",
          alignItems: "center",
          fontSize: "0.85rem",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: 2,
            background: color,
          }}
        />
        <strong>{label}</strong>
        <span style={{ color: "var(--text-muted)", fontFamily: "monospace" }}>{wav.fileName}</span>
        <button onClick={onPlay}>Play</button>
        <button onClick={onStop}>Stop</button>
      </div>
      <Waveform
        wav={wav}
        view={view}
        maxDuration={maxDuration}
        timeOffset={timeOffset}
        color={color}
        height={Math.max(120, 80 * wav.numChannels)}
        cursorSeconds={cursor}
        onCursorChange={onCursor}
        onViewChange={onViewChange}
      />
    </div>
  );
}

function DiffSummary({ a, b, offsetB }: { a: WavData; b: WavData; offsetB: number }) {
  const stats = useMemo(() => {
    if (a.numChannels !== b.numChannels) return null;
    // For each A sample i at time t = i/aRate, sample B linearly at time (t - offsetB).
    const lastB = b.totalFrames - 1;
    let maxAbs = 0;
    let sumSq = 0;
    let count = 0;
    for (let c = 0; c < a.numChannels; c++) {
      const ca = a.channels[c];
      const cb = b.channels[c];
      for (let i = 0; i < a.totalFrames; i++) {
        const jF = (i / a.sampleRate - offsetB) * b.sampleRate;
        if (jF < 0 || jF > lastB) continue;
        const j0 = Math.floor(jF);
        const frac = jF - j0;
        const j1 = j0 + 1 <= lastB ? j0 + 1 : j0;
        const bVal = cb[j0] * (1 - frac) + cb[j1] * frac;
        const d = ca[i] - bVal;
        const ad = Math.abs(d);
        if (ad > maxAbs) maxAbs = ad;
        sumSq += d * d;
        count++;
      }
    }
    if (count === 0) return { maxAbs: 0, rmse: 0, framesCompared: 0 };
    const rmse = Math.sqrt(sumSq / count);
    return { maxAbs, rmse, framesCompared: count / a.numChannels };
  }, [a, b, offsetB]);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "0.75rem 1rem",
        background: "var(--bg-surface)",
      }}
    >
      <div style={{ marginBottom: "0.4rem", fontWeight: 600 }}>A vs B</div>
      {!stats ? (
        <div style={{ color: "var(--text-muted)" }}>
          Files have different channel counts; diff not available.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "0.25rem 1rem",
            fontSize: "0.85rem",
            color: "var(--text-muted)",
          }}
        >
          <Field k="A samples compared" v={Math.round(stats.framesCompared).toLocaleString()} />
          <Field k="Max |A − B|" v={stats.maxAbs.toExponential(3)} />
          <Field k="RMSE (linear interp.)" v={stats.rmse.toExponential(3)} />
          <Field
            k="Length match"
            v={
              a.totalFrames === b.totalFrames
                ? "exact"
                : `Δ=${(a.totalFrames - b.totalFrames).toLocaleString()} frames`
            }
          />
        </div>
      )}
    </div>
  );
}
