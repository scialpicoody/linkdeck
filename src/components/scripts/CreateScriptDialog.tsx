import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";

export interface CreateScriptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => Promise<void>;
}

export default function CreateScriptDialog({
  open,
  onOpenChange,
  onCreate,
}: CreateScriptDialogProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setBusy(false);
    setError(null);
  }, [open]);

  async function submit(): Promise<void> {
    const value = name.trim();
    if (value.length === 0) {
      setError("Script name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(value);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 border border-border bg-card p-4 text-card-foreground shadow-lg"
        >
          <Dialog.Title className="text-sm font-medium">Create Lua script</Dialog.Title>
          <p className="mt-1 text-xs text-muted-foreground">
            Creates a new file in the configured workspace. Existing files are never overwritten.
          </p>
          <label htmlFor="new-script-name" className="mt-4 block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">File name</span>
            <input
              id="new-script-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="at-probe.lua"
              autoComplete="off"
              className="h-9 w-full border border-input bg-card px-2.5 font-mono text-sm focus:border-ring focus:outline-none"
            />
          </label>
          {error !== null && (
            <p role="alert" className="mt-3 text-xs text-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                className="h-9 border border-border bg-card px-3 text-sm hover:bg-muted"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={busy || name.trim().length === 0}
              onClick={() => void submit()}
              className="h-9 bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-45"
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
