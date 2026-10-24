export interface ThroughputChartProps {
  rx: number[];
  tx: number[];
}

function points(values: number[], max: number): string {
  if (values.length === 0) return "";
  return values
    .map((value, index) => {
      const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 120;
      const y = 30 - (value / max) * 26;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

/** Bounded, dependency-free 60-second RX/TX sparkline. */
export default function ThroughputChart({ rx, tx }: ThroughputChartProps) {
  const max = Math.max(1, ...rx, ...tx);
  return (
    <div className="border-b border-border px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="eyebrow text-muted-foreground">Throughput · 60s</span>
        <span className="flex gap-3 font-mono text-[8px] uppercase">
          <span className="text-rx">RX</span>
          <span className="text-tx">TX</span>
        </span>
      </div>
      <svg
        viewBox="0 0 120 32"
        preserveAspectRatio="none"
        role="img"
        aria-label="Rolling 60-second RX and TX throughput"
        className="mt-2 h-12 w-full border border-border bg-background/45"
      >
        <line x1="0" y1="30" x2="120" y2="30" stroke="var(--border)" strokeWidth="0.6" />
        <polyline
          points={points(rx, max)}
          fill="none"
          stroke="var(--rx)"
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={points(tx, max)}
          fill="none"
          stroke="var(--tx)"
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[7px] text-muted-foreground">
        <span>-60s</span>
        <span>{max} B/s peak</span>
        <span>now</span>
      </div>
    </div>
  );
}
