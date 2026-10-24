import { useMemo, useState } from "react";
import { toast } from "sonner";
import { cn } from "../../lib/utils";
import type { Parity, StopBits } from "../../mygo";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { type FieldOption, FieldSelect } from "../ui/FieldSelect";
import { type ChannelConfigValue, configsEqual, type FramingKind } from "./types";

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

const baudOptions: FieldOption[] = BAUD_RATES.map((b) => ({
  value: String(b),
  label: b.toLocaleString(),
}));
const dataBitOptions: FieldOption[] = DATA_BITS.map((d) => ({
  value: String(d),
  label: String(d),
}));
const parityOptions: FieldOption[] = PARITIES.map((p) => ({ value: p, label: p }));
const stopBitOptions: FieldOption[] = STOP_BITS.map((s) => ({ value: s, label: s }));
const framingOptions: FieldOption[] = FRAMING.map((f) => ({ value: f.value, label: f.label }));
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

export default function ChannelConfig({ initial, onApply }: ChannelConfigProps) {
  const [draft, setDraft] = useState<ChannelConfigValue>(initial);
  const [confirmReset, setConfirmReset] = useState(false);
  const dirty = useMemo(() => !configsEqual(draft, initial), [draft, initial]);

  function set<K extends keyof ChannelConfigValue>(key: K, value: ChannelConfigValue[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  const labelClass = "mb-1 block text-xs font-medium text-muted-foreground";
  const inputClass =
    "min-h-9 w-full rounded-[var(--radius)] border border-input bg-card px-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-2 focus:outline-ring";

  function handleApply() {
    try {
      onApply?.(draft);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Configuration apply failed", { description: message });
    }
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4"
      onSubmit={(e) => {
        e.preventDefault();
        handleApply();
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
          className={cn(inputClass, "font-mono")}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FieldSelect
          id="inspector-baud"
          label="Baud rate"
          value={String(draft.baudRate)}
          onValueChange={(v) => set("baudRate", Number(v))}
          options={baudOptions}
        />
        <FieldSelect
          id="inspector-data"
          label="Data bits"
          value={String(draft.dataBits)}
          onValueChange={(v) => set("dataBits", Number(v) as ChannelConfigValue["dataBits"])}
          options={dataBitOptions}
        />
        <FieldSelect
          id="inspector-parity"
          label="Parity"
          value={draft.parity}
          onValueChange={(v) => set("parity", v as Parity)}
          options={parityOptions}
        />
        <FieldSelect
          id="inspector-stop"
          label="Stop bits"
          value={draft.stopBits}
          onValueChange={(v) => set("stopBits", v as StopBits)}
          options={stopBitOptions}
        />
      </div>

      <FieldSelect
        id="inspector-framing"
        label="Framing"
        value={draft.framing}
        onValueChange={(v) => set("framing", v as FramingKind)}
        options={framingOptions}
      />

      <div>
        <label htmlFor="inspector-framing-opt" className={labelClass}>
          Framing option
        </label>
        <input
          id="inspector-framing-opt"
          value={draft.framingOption}
          onChange={(e) => set("framingOption", e.target.value)}
          autoComplete="off"
          className={inputClass}
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
          className={inputClass}
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
          onClick={() => setConfirmReset(true)}
          className="min-h-9 rounded-[var(--radius)] border border-border bg-card px-4 text-sm text-card-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reset
        </button>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Discard channel config changes?"
        description="Your edits will be lost and the form resets to the current channel settings."
        confirmLabel="Discard"
        onConfirm={() => setDraft(initial)}
      />
    </form>
  );
}
