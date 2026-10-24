import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { FramingKind } from "../inspector/types";
import { type FieldOption, FieldSelect } from "../ui/FieldSelect";
import { type ChannelFormValue, DEFAULT_CHANNEL_FORM, validateChannelForm } from "./types";

export interface ChannelDialogProps {
  /** Null = "open new channel"; non-null = edit existing (回填). */
  initial: ChannelFormValue | null;
  /** Available port names from polling (may be empty in browser-only mode). */
  ports: string[];
  /** Named presets for one-click fill (map name → value). */
  presets: Record<string, ChannelFormValue>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Owner sequences close+open and reports failure; dialog closes on resolve. */
  onSubmit: (value: ChannelFormValue) => Promise<void>;
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DATA_BITS = [5, 6, 7, 8];
const PARITIES = ["none", "odd", "even", "mark", "space"];
const STOP_BITS = ["1", "1.5", "2"];
const FRAMING: { value: FramingKind; label: string }[] = [
  { value: "delimiter", label: "Delimiter" },
  { value: "length-prefix", label: "Length prefix" },
  { value: "fixed-size", label: "Fixed size" },
  { value: "header-checksum", label: "Header + checksum" },
];

function optionsOf(values: (string | number)[]): FieldOption[] {
  return values.map((v) => ({ value: String(v), label: String(v) }));
}

/**
 * Unified open/edit dialog for channels (#18).
 *
 * Create mode (initial null): pick a port + parameters + optional preset
 * fill, submit calls SerialService.open via the owner. Edit mode (initial
 * set): the same form pre-filled; the owner sequences close+reopen and
 * rolls back on failure — this dialog never touches the transport itself.
 */
export function ChannelDialog({
  initial,
  ports,
  presets,
  open,
  onOpenChange,
  onSubmit,
}: ChannelDialogProps) {
  const [draft, setDraft] = useState<ChannelFormValue>(initial ?? DEFAULT_CHANNEL_FORM);
  const [presetName, setPresetName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form every time the dialog opens (create vs edit switch).
  useEffect(() => {
    if (open) {
      setDraft(initial ?? DEFAULT_CHANNEL_FORM);
      setPresetName("");
      setError(null);
    }
  }, [open, initial]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initial ?? DEFAULT_CHANNEL_FORM),
    [draft, initial],
  );

  function set<K extends keyof ChannelFormValue>(key: K, value: ChannelFormValue[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function applyPreset(name: string): void {
    setPresetName(name);
    const p = presets[name];
    if (p) setDraft({ ...p });
  }

  async function handleSubmit(): Promise<void> {
    const validationError = validateChannelForm(draft);
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(draft);
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(initial === null ? "Open channel failed" : "Apply config failed", {
        description: message,
      });
    } finally {
      setSaving(false);
    }
  }

  const presetOptions: FieldOption[] = useMemo(
    () => Object.keys(presets).map((n) => ({ value: n, label: n })),
    [presets],
  );

  const labelClass = "mb-1 block text-xs font-medium text-muted-foreground";
  const inputClass =
    "min-h-9 w-full rounded-[var(--radius)] border border-input bg-card px-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-2 focus:outline-ring";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-[var(--radius)] border border-border bg-card p-4 text-card-foreground shadow-lg"
        >
          <Dialog.Title className="text-sm font-medium">
            {initial === null ? "Open channel" : `Channel settings — ${initial.port}`}
          </Dialog.Title>
          <p className="mt-1 text-xs text-muted-foreground">
            {initial === null
              ? "Pick a port and parameters. Editing a live channel closes and reopens it."
              : "Applying closes and reopens the port; on failure the previous settings are kept."}
          </p>

          <div className="mt-4 flex flex-col gap-3">
            {presetOptions.length > 0 && (
              <FieldSelect
                id="channel-preset"
                label="Preset (fills the form)"
                value={presetName}
                onValueChange={applyPreset}
                options={presetOptions}
                placeholder="Choose a preset…"
              />
            )}

            {ports.length > 0 ? (
              <FieldSelect
                id="channel-port"
                label="Port"
                value={draft.port}
                onValueChange={(v) => set("port", v)}
                options={optionsOf(ports)}
                placeholder="Choose a port…"
              />
            ) : (
              <div>
                <label htmlFor="channel-port" className={labelClass}>
                  Port
                </label>
                <input
                  id="channel-port"
                  value={draft.port}
                  onChange={(e) => set("port", e.target.value)}
                  placeholder="/dev/tty.usbserial-…"
                  autoComplete="off"
                  className={inputClass}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <FieldSelect
                id="channel-baud"
                label="Baud rate"
                value={String(draft.baudRate)}
                onValueChange={(v) => set("baudRate", Number(v))}
                options={BAUD_RATES.map((b) => ({ value: String(b), label: b.toLocaleString() }))}
              />
              <FieldSelect
                id="channel-data"
                label="Data bits"
                value={String(draft.dataBits)}
                onValueChange={(v) => set("dataBits", Number(v) as ChannelFormValue["dataBits"])}
                options={optionsOf(DATA_BITS)}
              />
              <FieldSelect
                id="channel-parity"
                label="Parity"
                value={draft.parity}
                onValueChange={(v) => set("parity", v as ChannelFormValue["parity"])}
                options={optionsOf(PARITIES)}
              />
              <FieldSelect
                id="channel-stop"
                label="Stop bits"
                value={draft.stopBits}
                onValueChange={(v) => set("stopBits", v as ChannelFormValue["stopBits"])}
                options={optionsOf(STOP_BITS)}
              />
            </div>

            <FieldSelect
              id="channel-framing"
              label="Framing"
              value={draft.framing}
              onValueChange={(v) => set("framing", v as FramingKind)}
              options={FRAMING.map((f) => ({ value: f.value, label: f.label }))}
            />

            {draft.framing === "delimiter" && (
              <div>
                <label htmlFor="channel-delimiter" className={labelClass}>
                  Delimiter (hex)
                </label>
                <input
                  id="channel-delimiter"
                  value={draft.delimiterHex}
                  onChange={(e) => set("delimiterHex", e.target.value)}
                  placeholder="0A"
                  autoComplete="off"
                  className={inputClass}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Bytes that terminate each frame, e.g. 0A or 0D0A.
                </p>
              </div>
            )}

            {draft.framing === "fixed-size" && (
              <div>
                <label htmlFor="channel-fixed-size" className={labelClass}>
                  Frame size
                </label>
                <input
                  id="channel-fixed-size"
                  type="number"
                  min={1}
                  value={draft.fixedSize}
                  onChange={(e) => set("fixedSize", Number(e.target.value))}
                  className={inputClass}
                />
              </div>
            )}

            {(draft.framing === "length-prefix" || draft.framing === "header-checksum") && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label htmlFor="channel-length-offset" className={labelClass}>
                    Length offset
                  </label>
                  <input
                    id="channel-length-offset"
                    type="number"
                    min={0}
                    value={draft.lengthOffset}
                    onChange={(e) => set("lengthOffset", Number(e.target.value))}
                    className={inputClass}
                  />
                </div>
                <FieldSelect
                  id="channel-length-width"
                  label="Width"
                  value={String(draft.lengthWidth)}
                  onValueChange={(v) => set("lengthWidth", Number(v))}
                  options={optionsOf([1, 2, 4])}
                />
                <FieldSelect
                  id="channel-length-endian"
                  label="Endian"
                  value={draft.lengthEndian}
                  onValueChange={(v) => set("lengthEndian", v as ChannelFormValue["lengthEndian"])}
                  options={[
                    { value: "big", label: "Big" },
                    { value: "little", label: "Little" },
                  ]}
                />
              </div>
            )}

            {draft.framing === "header-checksum" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="channel-header" className={labelClass}>
                    Header (hex)
                  </label>
                  <input
                    id="channel-header"
                    value={draft.headerHex}
                    onChange={(e) => set("headerHex", e.target.value)}
                    placeholder="AA55"
                    autoComplete="off"
                    className={inputClass}
                  />
                </div>
                <FieldSelect
                  id="channel-checksum"
                  label="Checksum"
                  value={draft.checksum}
                  onValueChange={(v) => set("checksum", v as ChannelFormValue["checksum"])}
                  options={[
                    { value: "xor", label: "XOR" },
                    { value: "sum8", label: "Sum8" },
                    { value: "crc8", label: "CRC-8" },
                  ]}
                />
              </div>
            )}

            <div>
              <label htmlFor="channel-max-frame" className={labelClass}>
                Max frame size (bytes, 0 = default)
              </label>
              <input
                id="channel-max-frame"
                type="number"
                min={0}
                value={draft.maxFrameSize}
                onChange={(e) => set("maxFrameSize", Number(e.target.value))}
                className={inputClass}
              />
            </div>
          </div>

          {error !== null && (
            <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                className="min-h-9 rounded-[var(--radius)] border border-border bg-card px-4 text-sm hover:bg-muted"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void handleSubmit()}
              className="min-h-9 rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {(() => {
                if (saving) return "Working…";
                if (initial === null) return "Open";
                return "Apply & reopen";
              })()}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
