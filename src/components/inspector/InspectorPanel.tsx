import { useState } from "react";
import ChannelConfig from "./ChannelConfig";
import FrameDetail from "./FrameDetail";
import SessionStats from "./SessionStats";
import {
  type ChannelConfigValue,
  DEFAULT_CONFIG,
  type InspectorFrame,
  type SessionStatsValue,
} from "./types";

export type InspectorTab = "detail" | "config" | "stats";

export interface InspectorPanelProps {
  /** Selected frame for the detail tab; null shows the empty state. */
  frame?: InspectorFrame | null;
  /** Current channel settings for the config tab. */
  config?: ChannelConfigValue;
  /**
   * Apply stub the integrator wires to the real path (close + SerialService.open
   * sequenced by the owner — never called directly from ChannelConfig).
   */
  onApplyConfig?: (cfg: ChannelConfigValue) => void;
  /** Session counters + throughput buckets for the stats tab. */
  stats?: SessionStatsValue;
  /** Initial tab. Defaults to "detail". */
  defaultTab?: InspectorTab;
}

const TABS: { id: InspectorTab; label: string }[] = [
  { id: "detail", label: "Detail" },
  { id: "config", label: "Config" },
  { id: "stats", label: "Stats" },
];

/**
 * Right-rail inspector: frame detail / channel config / session stats.
 * Entirely mock-prop driven; the integrator supplies frame/config/stats from
 * the channel store and wires onApplyConfig to the close+open sequence.
 */
export default function InspectorPanel({
  frame = null,
  config = DEFAULT_CONFIG,
  onApplyConfig,
  stats,
  defaultTab = "detail",
}: InspectorPanelProps) {
  const [tab, setTab] = useState<InspectorTab>(defaultTab);
  const effectiveStats: SessionStatsValue = stats ?? {
    startedAtMs: Date.now(),
    rxBytes: 0,
    txBytes: 0,
    rxFrames: 0,
    txFrames: 0,
    framingErrors: 0,
    checksumErrors: 0,
    samples: [],
  };

  return (
    <section
      aria-label="Inspector"
      className="flex min-h-0 w-full flex-1 flex-col rounded-[var(--radius)] border border-border bg-background text-foreground"
    >
      <div
        role="tablist"
        aria-label="Inspector tabs"
        className="flex gap-1 border-b border-border px-3 py-2"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={
              tab === t.id
                ? "rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground"
                : "rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "detail" && <FrameDetail frame={frame} />}
      {tab === "config" && (
        <ChannelConfig key={config.port} initial={config} onApply={onApplyConfig} />
      )}
      {tab === "stats" && <SessionStats stats={effectiveStats} />}
    </section>
  );
}
