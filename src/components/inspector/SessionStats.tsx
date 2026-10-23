import { useMemo } from "react";
import type { SessionStatsValue } from "./types";

export interface SessionStatsProps {
  /** Session counters + recent throughput buckets (mock or store-provided). */
  stats: SessionStatsValue;
  /** Trailing window for the curve, in seconds. Defaults to 60. */
  windowSecs?: number;
}

const W = 260;
const H = 64;

function pointsFor(values: number[], max: number): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    const y = H - 4 - (values[0]! / Math.max(max, 1)) * (H - 8);
    return `0,${y.toFixed(1)} ${W},${y.toFixed(1)}`;
  }
  const step = W / (values.length - 1);
  return values
    .map((v, i) => {
      const y = H - 4 - (v / Math.max(max, 1)) * (H - 8);
      return `${(i * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function areaFor(line: string): string {
  if (!line) return "";
  return `0,${H} ${line} ${W},${H}`;
}

export default function SessionStats({ stats, windowSecs = 60 }: SessionStatsProps) {
  const windowed = useMemo(() => {
    const cutoff = Date.now() - windowSecs * 1000;
    return stats.samples.filter((s) => s.t >= cutoff);
  }, [stats.samples, windowSecs]);

  const { rxLine, txLine, rxArea, txArea, peak } = useMemo(() => {
    const rx = windowed.map((s) => s.rxBytes);
    const tx = windowed.map((s) => s.txBytes);
    const top = Math.max(1, ...rx, ...tx);
    const r = pointsFor(rx, top);
    const t = pointsFor(tx, top);
    return { rxLine: r, txLine: t, rxArea: areaFor(r), txArea: areaFor(t), peak: top };
  }, [windowed]);

  const uptimeSecs = Math.max(0, Math.floor((Date.now() - stats.startedAtMs) / 1000));

  const totals: { label: string; value: string }[] = [
    { label: "RX", value: `${stats.rxBytes.toLocaleString()} B · ${stats.rxFrames.toLocaleString()} frames` },
    { label: "TX", value: `${stats.txBytes.toLocaleString()} B · ${stats.txFrames.toLocaleString()} frames` },
    {
      label: "Errors",
      value: `${stats.framingErrors + stats.checksumErrors} (${stats.framingErrors} framing · ${stats.checksumErrors} checksum)`,
    },
    { label: "Uptime", value: `${Math.floor(uptimeSecs / 60)}m ${uptimeSecs % 60}s` },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
      <dl className="grid grid-cols-2 gap-2">
        {totals.map((t) => (
          <div
            key={t.label}
            className="rounded-[var(--radius)] border border-border bg-card px-3 py-2"
          >
            <dt className="text-[11px] font-medium text-muted-foreground">{t.label}</dt>
            <dd className="mt-0.5 truncate font-mono text-xs text-card-foreground" title={t.value}>
              {t.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="rounded-[var(--radius)] border border-border bg-card px-3 py-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-medium text-card-foreground">
            Throughput (last {windowSecs}s)
          </h3>
          <p className="font-mono text-[11px] text-muted-foreground">peak {peak.toLocaleString()} B/s</p>
        </div>
        {windowed.length === 0 ? (
          <p className="py-5 text-center text-xs text-muted-foreground">
            No samples yet — traffic in the last {windowSecs}s will draw here.
          </p>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Rolling throughput: peak ${peak} bytes per second`}
            className="mt-2 h-16 w-full"
          >
            <polygon points={rxArea} fill="var(--primary)" opacity={0.15} />
            <polygon points={txArea} fill="var(--accent-foreground)" opacity={0.2} />
            <polyline
              points={rxLine}
              fill="none"
              stroke="var(--primary)"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
            <polyline
              points={txLine}
              fill="none"
              stroke="var(--accent-foreground)"
              strokeWidth={1.5}
              strokeDasharray="4 2"
              strokeLinejoin="round"
            />
          </svg>
        )}
        <div className="mt-1.5 flex gap-4 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 bg-primary" /> RX
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 bg-accent-foreground" /> TX
          </span>
        </div>
      </div>
    </div>
  );
}
