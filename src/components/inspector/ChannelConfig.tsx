import { useMemo, useState } from "react";
import type { ChannelConfigValue, FramingKind } from "./types";
import type { Parity, StopBits } from "../../mygo";

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DATA_BITS = [5, 6, 7, 8] as const;
const PARITIES: Parity[] = ["none", "odd", "even", "mark", "space"];
const STOP_BITS: StopBits[] = ["1", "1.5", "2"];
const FRAMING: { value: FramingKind; label: string }[] = [
  { value: "delimiter", label: "Delimiter" },
  { value: "length-prefix", label: "Length prefix" },
  { value: "fixed-size", label: "Fixed size" },
  { value: "header-checksum", label: "Header + checksum" },
];

const FRAMING_HINT: Record<FramingKind, string> = {
  delimiter: "Delimiter byte as hex, e.g. 0A for LF.",
  "length-prefix": "Length-field width in bytes, e.g. 2.",
  "fixed-size": "Frame size in bytes, e.g. 64.",
  "header-checksum": "Checksum name, e.g. crc16.",
};

export interface ChannelConfigProps {
  /** Current channel settings (mock or store-provided). */
  initial: ChannelConfigValue;
  /**
   * Stub the integrator wires to the real apply path. NOTE (MCSP9
   * chicken-and-egg): this panel deliberately never calls
   * SerialService.open itself — opening requires a closed port while the
   * channel may be live, so edits stay local until Apply hands the value
   * to the owner, which sequences close/open outside this component.
   */
  onApply?: (cfg: ChannelConfigValue) => void;
}

function configsEqual(a: ChannelConfigValue, b: ChannelConfigValue): boolean {
  return (
    a.port === b.port &&
    a.baudRate === b.baudRate &&
    a.dataBits === b.dataBits &&
    a.parity === b.parity &&
    a.stopBits === b.stopBits &&
    a.framing === b.framing &&
    a.framingOption === b.framingOption &&
    a.readTimeoutMs === b.readTimeoutMs
  );
}

export default function ChannelConfig({ initial, onApply }: ChannelConfigProps) {
  const [draft, setDraft] = useState<ChannelConfigValue>(initial);
  const dirty = useMemo(() => !configsEqual(draft, initial), [draft, initial]);

  function set<K extends keyof ChannelConfigValue>(key: K, value: ChannelConfigValue[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  const selectClass =
    "min-h-9 w-full rounded-[var(--radius)] border border-input bg-card px-2.5 text-sm text-foreground focus:outline-2 focus:outline-ring";
  const labelClass = "mb-1 block text-xs font-medium text-muted-foreground";

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onApply?.(draft);
      }}
    >
      <div>
        <label htmlFor="inspector-port" className={labelClass}>
          Port
        </label>
        <input
          id="inspector-port"
          value={draft.port}
          onChange={(e) => set("port", e.target.value)}
          placeholder="/dev/tty.usbserial-…"
          autoComplete="off"
          className="min-h-9 w-full rounded-[var(--radius)] border border-input bg-card px-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-2 focus:outline-ring"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="inspector-baud" className={labelClass}>
            Baud rate
          </label>
          <select
            id="inspector-baud"
            value={draft.baudRate}
            onChange={(e) => set("baudRate", Number(e.target.value))}
            className={selectClass}
          >
            {BAUD_RATES.map((b) => (
              <option key={b} value={b}>
                {b.toLocaleString()}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="inspector-data" className={labelClass}>
            Data bits
          </label>
          <select
            id="inspector-data"
            value={draft.dataBits}
            onChange={(e) => set("dataBits", Number(e.target.value) as ChannelConfigValue["dataBits"])}
            className={selectClass}
          >
            {DATA_BITS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="inspector-parity" className={labelClass}>
            Parity
          </label>
          <select
            id="inspector-parity"
            value={draft.parity}
            onChange={(e) => set("parity", e.target.value as Parity)}
            className={selectClass}
          >
            {PARITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="inspector-stop" className={labelClass}>
            Stop bits
          </label>
          <select
            id="inspector-stop"
            value={draft.stopBits}
            onChange={(e) => set("stopBits", e.target.value as StopBits)}
            className={selectClass}
          >
            {STOP_BITS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="inspector-framing" className={labelClass}>
          Framing
        </label>
        <select
          id="inspector-framing"
          value={draft.framing}
          onChange={(e) => set("framing", e.target.value as FramingKind)}
          className={selectClass}
        >
          {FRAMING.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="inspector-framing-opt" className={labelClass}>
          Framing option
        </label>
        <input
          id="inspector-framing-opt"
          value={draft.framingOption}
          onChange={(e) => set("framingOption", e.target.value)}
          autoComplete="off"
          className="min-h-9 w-full rounded-[var(--radius)] border border-input bg-card px-2.5 font-mono text-sm text-foreground focus:outline-2 focus:outline-ring"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">{FRAMING_HINT[draft.framing]}</p>
      </div>

      <div>
        <label htmlFor="inspector-timeout" className={labelClass}>
          Read timeout (ms; 0 = default, −1 = off)
        </label>
        <input
          id="inspector-timeout"
          type="number"
          step={1}
          value={draft.readTimeoutMs}
          onChange={(e) => set("readTimeoutMs", Number(e.target.value))}
          className="min-h-9 w-full rounded-[var(--radius)] border border-input bg-card px-2.5 font-mono text-sm text-foreground focus:outline-2 focus:outline-ring"
        />
      </div>

      <div className="mt-auto flex gap-2 pt-2">
        <button
          type="submit"
          disabled={!dirty}
          className="min-h-9 flex-1 rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Apply
        </button>
        <button
          type="button"
          disabled={!dirty}
          onClick={() => setDraft(initial)}
          className="min-h-9 rounded-[var(--radius)] border border-border bg-card px-4 text-sm text-card-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reset
        </button>
      </div>
    </form>
  );
}
