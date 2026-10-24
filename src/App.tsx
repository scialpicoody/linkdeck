import { useCallback, useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import type { ChannelFormValue } from "./components/channels";
import { ChannelDialog } from "./components/channels";
import {
  type Frame,
  FrameInspector,
  FramePanel,
  type SendPayload,
  toWireString,
} from "./components/frames";
import { Sidebar } from "./components/layout/Sidebar";
import { StatusBar } from "./components/layout/StatusBar";
import { TabStrip } from "./components/layout/TabStrip";
import type { ScriptEntry, ScriptOutputRow } from "./components/scripts";
import { ScriptEditor, ScriptLibrary, ScriptOutput } from "./components/scripts";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { HintsProvider } from "./components/ui/Hint";
import { useChannels } from "./lib/channels";
import { isHostAvailable } from "./lib/host";
import { ConfigAPI, type Preset, SerialService } from "./mygo";

/** Main-area view: frame monitor vs script workspace (task states). */
type MainView = "monitor" | "scripts";

const DEMO_SCRIPTS: ScriptEntry[] = [
  { id: "at-probe", name: "at-probe.lua", path: "scripts/at-probe.lua", origin: "workspace" },
  { id: "echo-check", name: "echo-check.lua", path: "scripts/echo-check.lua", origin: "workspace" },
];

const LUA_STARTER =
  '-- LinkDeck script: serial/tcp handles arrive in a later phase.\nlog("hello from " .. "script")\n';

export default function App() {
  const {
    channels,
    tabs,
    activeId,
    active,
    portsLoading,
    listError,
    openChannel,
    closeChannel,
    selectChannel,
    markRead,
    resetCounters,
    setChannelState,
  } = useChannels();
  // Per-channel TX echo frames. RX frames arrive with the framing phase,
  // which feeds this same map through a mygo event.
  const [framesByChannel, setFramesByChannel] = useState<Record<string, Frame[]>>({});
  // Selected frame row → slide-over inspector (#20). Cleared on channel switch.
  const [frameSelection, setFrameSelection] = useState<{ frame: Frame; index: number } | null>(
    null,
  );
  const [mainView, setMainView] = useState<MainView>("monitor");
  // Scripts view: open editor tabs (multi-tab) + per-tab sources.
  const [openScriptIds, setOpenScriptIds] = useState<string[]>([]);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [scriptSources, setScriptSources] = useState<Record<string, string>>({});
  const [outputRows, setOutputRows] = useState<ScriptOutputRow[]>([]);
  const [errorLine, setErrorLine] = useState<number | null>(null);
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  // Channel dialog: null = closed; {mode:"create"} or {mode:"edit", id}.
  const [channelDialog, setChannelDialog] = useState<
    { mode: "create" } | { mode: "edit"; id: string } | null
  >(null);
  const [presets, setPresets] = useState<Record<string, ChannelFormValue>>({});

  // Load named presets once (browser-only mode: none).
  useEffect(() => {
    if (!isHostAvailable()) return;
    ConfigAPI.presets()
      .then((all: Record<string, Preset>) => {
        const mapped: Record<string, ChannelFormValue> = {};
        for (const [name, p] of Object.entries(all)) {
          mapped[name] = {
            port: p.Endpoint,
            baudRate: p.Baud,
            dataBits: (p.DataBits === 5 || p.DataBits === 6 || p.DataBits === 7
              ? p.DataBits
              : 8) as ChannelFormValue["dataBits"],
            parity: (p.Parity ?? "none") as ChannelFormValue["parity"],
            stopBits: (p.StopBits ?? "1") as ChannelFormValue["stopBits"],
            framing: "delimiter",
            framingOption: "0A",
            readTimeoutMs: p.ReadTimeoutMs ?? 0,
          };
        }
        setPresets(mapped);
      })
      .catch(() => {});
  }, []);

  // Clear the unread badge and frame selection on channel switch.
  useEffect(() => {
    if (activeId !== null) markRead(activeId);
    setFrameSelection(null);
    setSendError(null);
  }, [activeId, markRead]);
  // Surface port-enumeration failures as a toast (sidebar shows it inline too).
  useEffect(() => {
    if (listError !== null) {
      toast.error("Port refresh failed", { description: listError });
    }
  }, [listError]);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const handleSend = useCallback(
    async (payload: SendPayload) => {
      if (active === null || active.kind !== "serial") return;
      const id = active.id;
      const portName = active.name;
      const { wire, error } = toWireString(payload);
      if (error !== null) {
        setSendError(error);
        return;
      }
      setSending(true);
      setSendError(null);
      try {
        await SerialService.send(portName, wire);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // TX failure: red row in the frame table (not the script output) +
        // inline composer error + toast. No dependency on Output visibility.
        setFramesByChannel((prev) => ({
          ...prev,
          [id]: [
            ...(prev[id] ?? []),
            { dir: "out", data: `⚠ send failed: ${message}`, ts: Date.now() },
          ],
        }));
        setSendError(message);
        toast.error(`Send to ${portName} failed`, { description: message });
        return;
      } finally {
        setSending(false);
      }
      setFramesByChannel((prev) => ({
        ...prev,
        [id]: [...(prev[id] ?? []), { dir: "out", data: wire, ts: Date.now() }],
      }));
    },
    [active],
  );

  const handleRun = useCallback((script: ScriptEntry) => {
    // Stub until the Go scripting engine lands: record the request visibly.
    setOutputRows((rows) => [
      ...rows,
      {
        type: "log",
        channel: "scripts",
        direction: "out",
        data: `run requested: ${script.path} (scripting engine pending)`,
        ts: Date.now(),
      },
    ]);
  }, []);

  function openScriptTab(script: ScriptEntry): void {
    setOpenScriptIds((prev) => (prev.includes(script.id) ? prev : [...prev, script.id]));
    setSelectedScriptId(script.id);
    setErrorLine(null);
    setScriptSources((prev) =>
      prev[script.id] !== undefined ? prev : { ...prev, [script.id]: LUA_STARTER },
    );
  }

  function closeScriptTab(id: string): void {
    setOpenScriptIds((prev) => prev.filter((t) => t !== id));
    setSelectedScriptId((sel) => {
      if (sel !== id) return sel;
      const rest = openScriptIds.filter((t) => t !== id);
      return rest.length > 0 ? (rest[rest.length - 1] as string) : null;
    });
  }

  const handleClear = useCallback(() => {
    if (active === null) return;
    const id = active.id;
    setFramesByChannel((prev) => ({ ...prev, [id]: [] }));
    setFrameSelection(null);
  }, [active]);

  // Unified submit for the channel dialog (#18). Create: open + tab.
  // Edit: close + reopen; failure keeps the previous (still-open) settings.
  const handleChannelSubmit = useCallback(
    async (value: ChannelFormValue) => {
      if (!isHostAvailable()) throw new Error("No Go host: cannot open channels in browser mode.");
      const editing = channelDialog !== null && channelDialog.mode === "edit";
      if (editing) setChannelState(value.port, "connecting");
      try {
        if (editing) {
          try {
            await SerialService.close(value.port);
          } catch {
            // Already closed / never opened: proceed to open.
          }
        }
        await SerialService.open({
          port: value.port,
          baudRate: value.baudRate,
          dataBits: value.dataBits,
          parity: value.parity,
          stopBits: value.stopBits,
          readTimeoutMs: value.readTimeoutMs,
        });
        setChannelState(value.port, "connected");
        openChannel(value.port);
        selectChannel(value.port);
      } catch (err) {
        setChannelState(value.port, "error", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [channelDialog, openChannel, selectChannel, setChannelState],
  );

  const dialogPorts = useMemo(() => channels.map((c) => c.name), [channels]);
  const dialogInitial = useMemo<ChannelFormValue | null>(() => {
    if (channelDialog === null || channelDialog.mode === "create") return null;
    const ch = channels.find((c) => c.id === channelDialog.id);
    if (!ch) return null;
    return {
      port: ch.name,
      baudRate: 115200,
      dataBits: 8,
      parity: "none",
      stopBits: "1",
      framing: "delimiter",
      framingOption: "0A",
      readTimeoutMs: 0,
    };
  }, [channelDialog, channels]);

  return (
    <HintsProvider>
      <div className="flex h-screen w-full flex-col bg-background text-foreground">
        <div className="flex min-h-0 flex-1">
          <Sidebar
            channels={channels}
            activeId={activeId}
            loading={portsLoading}
            listError={listError}
            onOpen={openChannel}
            onSelect={selectChannel}
            onAdd={() => setChannelDialog({ mode: "create" })}
            onEdit={(id) => setChannelDialog({ mode: "edit", id })}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-w-0 items-stretch gap-2 border-b border-border bg-background">
              <div
                role="tablist"
                aria-label="Main view"
                className="flex shrink-0 items-center gap-1 self-center rounded-md bg-muted p-0.5"
              >
                {(["monitor", "scripts"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={mainView === v}
                    onClick={() => setMainView(v)}
                    className={
                      mainView === v
                        ? "rounded px-3 py-1 text-xs font-medium bg-card shadow-sm"
                        : "rounded px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
                    }
                  >
                    {v === "monitor" ? "Monitor" : "Scripts"}
                  </button>
                ))}
              </div>
              {mainView === "monitor" && (
                <TabStrip
                  tabs={tabs}
                  channels={channels}
                  activeId={activeId}
                  onSelect={selectChannel}
                  onClose={(id) => setPendingCloseId(id)}
                />
              )}
            </div>
            <div className="flex min-h-0 flex-1">
              {mainView === "monitor" ? (
                <>
                  <main className="flex min-w-0 flex-1 flex-col">
                    <div className="min-h-0 flex-1">
                      <FramePanel
                        channelName={active?.name ?? null}
                        frames={active !== null ? (framesByChannel[active.id] ?? []) : []}
                        onSelectFrame={(frame, index) => setFrameSelection({ frame, index })}
                        onSend={handleSend}
                        onClear={handleClear}
                        canSend={active !== null && active.kind === "serial"}
                        sending={sending}
                        sendError={sendError}
                      />
                    </div>
                  </main>
                  <FrameInspector
                    selection={
                      frameSelection !== null && active !== null
                        ? { frame: frameSelection.frame, channelName: active.name }
                        : null
                    }
                    onClose={() => setFrameSelection(null)}
                  />
                </>
              ) : (
                <main className="flex min-w-0 flex-1">
                  <div className="w-64 shrink-0 overflow-auto border-r border-border">
                    <ScriptLibrary
                      workspaceScripts={DEMO_SCRIPTS}
                      selectedId={selectedScriptId}
                      onSelect={openScriptTab}
                      onRun={handleRun}
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    {openScriptIds.length === 0 ? (
                      <div className="grid flex-1 place-items-center p-6 text-center">
                        <p className="text-sm text-muted-foreground">
                          Pick a script on the left to open it in a tab. The monitor stays one click
                          away.
                        </p>
                      </div>
                    ) : (
                      <>
                        <div
                          role="tablist"
                          aria-label="Open scripts"
                          className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5"
                        >
                          {openScriptIds.map((id) => {
                            const entry = DEMO_SCRIPTS.find((s) => s.id === id);
                            const isSel = id === selectedScriptId;
                            return (
                              <div
                                key={id}
                                role="tab"
                                aria-selected={isSel}
                                tabIndex={0}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    setSelectedScriptId(id);
                                    setErrorLine(null);
                                  }
                                }}
                                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                                  isSel ? "border-border bg-card" : "border-transparent"
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedScriptId(id);
                                    setErrorLine(null);
                                  }}
                                  className="max-w-40 truncate font-mono"
                                >
                                  {entry?.name ?? id}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => closeScriptTab(id)}
                                  aria-label={`Close ${entry?.name ?? id}`}
                                  className="rounded p-0.5 text-muted-foreground hover:bg-muted"
                                >
                                  ×
                                </button>
                              </div>
                            );
                          })}
                        </div>
                        <div className="min-h-0 flex-1">
                          <ScriptEditor
                            value={
                              selectedScriptId !== null
                                ? (scriptSources[selectedScriptId] ?? LUA_STARTER)
                                : LUA_STARTER
                            }
                            onChange={(v) => {
                              if (selectedScriptId !== null)
                                setScriptSources((prev) => ({ ...prev, [selectedScriptId]: v }));
                            }}
                            errorLine={errorLine}
                          />
                        </div>
                      </>
                    )}
                  </div>
                  <div className="w-80 shrink-0 overflow-auto border-l border-border">
                    <ScriptOutput rows={outputRows} onErrorLine={setErrorLine} />
                  </div>
                </main>
              )}
            </div>
          </div>
        </div>
        <StatusBar channel={active} onResetCounters={resetCounters} />
        <Toaster position="bottom-right" theme="system" />
        <ChannelDialog
          initial={dialogInitial}
          ports={dialogPorts}
          presets={presets}
          open={channelDialog !== null}
          onOpenChange={(open) => {
            if (!open) setChannelDialog(null);
          }}
          onSubmit={handleChannelSubmit}
        />
        <ConfirmDialog
          open={pendingCloseId !== null}
          onOpenChange={(open) => {
            if (!open) setPendingCloseId(null);
          }}
          title="Close channel tab?"
          description="The tab closes but the channel stays listed in the sidebar. Unsent composer text is lost."
          confirmLabel="Close tab"
          onConfirm={() => {
            if (pendingCloseId !== null) closeChannel(pendingCloseId);
            setPendingCloseId(null);
          }}
        />
      </div>
    </HintsProvider>
  );
}
