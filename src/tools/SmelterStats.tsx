import { useState, useEffect, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface DataPoint {
  time: string;
  value: number;
}

function generatePoint(): DataPoint {
  return {
    time: new Date().toLocaleTimeString(),
    value: Math.random() * 100,
  };
}

const MAX_POINTS = 30;

export default function SmelterStats() {
  const [data, setData] = useState<DataPoint[]>(() =>
    Array.from({ length: 10 }, generatePoint),
  );
  const [running, setRunning] = useState(true);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setData((prev) => [...prev.slice(-(MAX_POINTS - 1)), generatePoint()]);
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  const toggle = useCallback(() => setRunning((r) => !r), []);

  return (
    <>
      <p>Real-time chart — streaming random data every second.</p>
      <button onClick={toggle} style={{ marginBottom: "1rem" }}>
        {running ? "Pause" : "Resume"}
      </button>
      <ResponsiveContainer width="100%" height={400}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="time" />
          <YAxis domain={[0, 100]} />
          <Tooltip />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#8884d8"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}
