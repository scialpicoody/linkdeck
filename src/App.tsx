import { Code2, ScanSearch, SendHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import type { ChannelFormValue } from "./components/channels";
import {
  ChannelDialog,
  DEFAULT_CHANNEL_FORM,
  framingFormFromPreset,
  framingFormFromSpec,
  toFramingSpec,
} from "./components/channels";
import {
  base64ToBytes,
  Composer,
  type Frame,
  FrameInspector,
  FramePanel,
  type SendPayload,
  toWireString,
} from "./components/frames";
import { Sidebar } from "./components/layout/Sidebar";
import { StatusBar } from "./components/layout/StatusBar";
import { type MainView, WorkbenchHeader } from "./components/layout/WorkbenchHeader";
import type { ScriptEntry, ScriptOutputRow } from "./components/scripts";
import { ScriptEditor, ScriptLibrary, ScriptOutput } from "./components/scripts";
import { HintsProvider } from "./components/ui/Hint";
import {
  type Channel,
  createChannelId,
  type SerialChannelConfig,
  useChannels,
} from "./lib/channels";
import { appendFrames, EMPTY_FRAME_BUFFER, type FrameBuffer } from "./lib/frame-store";
import { isHostAvailable } from "./lib/host";
import { cn } from "./lib/utils";
import {
  ConfigAPI,
  events,
  type FrameDTO,
  type FramingError,
  type OpenRequest,
  type Preset,
  SerialService,
  StreamAPI,
} from "./mygo";

const DEMO_SCRIPTS: ScriptEntry[] = [
  { id: "at-probe", name: "at-probe.lua", path: "scripts/at-probe.lua", origin: "workspace" },
  { id: "echo-check", name: "echo-check.lua", path: "scripts/echo-check.lua", origin: "workspace" },
];

const LUA_STARTER =
  '-- LinkDeck script: serial/tcp handles arrive in a later phase.\nlog("hello from " .. "script")\n';

function configFromForm(value: ChannelFormValue): SerialChannelConfig {
  return {
    baudRate: value.baudRate,
    dataBits: value.dataBits,
    parity: value.parity,
    stopBits: value.stopBits,
    readTimeoutMs: value.readTimeoutMs,
    framing: toFramingSpec(value),
  };
}

function openRequest(port: string, config: SerialChannelConfig): OpenRequest {
  return {
    port,
    baudRate: config.baudRate,
    dataBits: config.dataBits,
    parity: config.parity,
    stopBits: config.stopBits,
    readTimeoutMs: config.readTimeoutMs,
    framing: config.framing,
  };
}

function presetFromForm(value: ChannelFormValue): Preset {
  return {
    Transport: "serial",
    Endpoint: value.port.trim(),
    Baud: value.baudRate,
    DataBits: value.dataBits,
    Parity: value.parity,
    StopBits: value.stopBits,
    Framing: {
      Name: value.framing,
      Opts: {},
      Spec: toFramingSpec(value),
    },
    ReadTimeoutMs: value.readTimeoutMs,
    Reconnect: {
      Enabled: false,
      InitialMs: 100,
      MaxMs: 5000,
      MaxAttempts: 0,
    },
  };
}

function formFromChannel(channel: Channel): ChannelFormValue {
  const config = channel.config;
  return {
    ...DEFAULT_CHANNEL_FORM,
    port: channel.endpoint,
    baudRate: config.baudRate,
    dataBits: config.dataBits,
    parity: config.parity,
    stopBits: config.stopBits,
    readTimeoutMs: config.readTimeoutMs,
    ...framingFormFromSpec(config.framing),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotOpenError(error: unknown): boolean {
  return /not open|unknown/i.test(messageOf(error));
}

export default function App() {
  const {
    ports,
    channels,
    activeId,
    active,
    portsLoading,
    listError,
    selectChannel,
    markRead,
    resetCounters,
    addChannel,
    updateChannel,
    removeChannel,
    addTraffic,
  } = useChannels();
  const [framesByChannel, setFramesByChannel] = useState<Record<string, FrameBuffer>>({});
  const [droppedByChannel, setDroppedByChannel] = useState<Record<string, number>>({});
  const [framingErrorsByChannel, setFramingErrorsByChannel] = useState<
    Record<string, FramingError>
  >({});
  // Selected frame row → slide-over inspector (#20). Cleared on channel switch.
  const [frameSelection, setFrameSelection] = useState<{ frame: Frame; index: number } | null>(
    null,
  );
  const [mainView, setMainView] = useState<MainView>("monitor");
  const [dockTab, setDockTab] = useState<"send" | "inspect">("send");
  // Scripts view: open editor tabs (multi-tab) + per-tab sources.
  const [openScriptIds, setOpenScriptIds] = useState<string[]>([]);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [scriptSources, setScriptSources] = useState<Record<string, string>>({});
  const [outputRows, setOutputRows] = useState<ScriptOutputRow[]>([]);
  const [errorLine, setErrorLine] = useState<number | null>(null);
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
            ...DEFAULT_CHANNEL_FORM,
            ...framingFormFromPreset(p.Framing),
            port: p.Endpoint,
            baudRate: p.Baud,
            dataBits: (p.DataBits === 5 || p.DataBits === 6 || p.DataBits === 7
              ? p.DataBits
              : 8) as ChannelFormValue["dataBits"],
            parity: (p.Parity ?? "none") as ChannelFormValue["parity"],
            stopBits: (p.StopBits ?? "1") as ChannelFormValue["stopBits"],
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

  // Live RX path: Go emits unmatched complete frames as base64 FrameDTOs.
  useEffect(() => {
    if (!isHostAvailable()) return;
    const byEndpoint = new Map(channels.map((channel) => [channel.endpoint, channel]));
    return events.frames.on((batch: FrameDTO[]) => {
      const byChannel = new Map<string, { endpoint: string; frames: Frame[] }>();
      let malformed = 0;
      for (const dto of batch) {
        if (dto.dir !== "rx" && dto.dir !== "tx") continue;
        const channel = byEndpoint.get(dto.channel);
        if (channel === undefined) continue;
        try {
          const frame: Frame = {
            dir: dto.dir === "rx" ? "in" : "out",
            payload: base64ToBytes(dto.payload),
            ts: dto.tsMillis,
          };
          const entry = byChannel.get(channel.id) ?? { endpoint: channel.endpoint, frames: [] };
          entry.frames.push(frame);
          byChannel.set(channel.id, entry);
        } catch {
          malformed++;
        }
      }

      if (malformed > 0) {
        toast.error("Dropped malformed frame event", {
          description: `${malformed} payload${malformed === 1 ? "" : "s"} were not valid base64.`,
        });
      }
      if (byChannel.size === 0) return;

      setFramesByChannel((previous) => {
        const next = { ...previous };
        for (const [id, entry] of byChannel) {
          next[id] = appendFrames(previous[id] ?? EMPTY_FRAME_BUFFER, entry.frames);
        }
        return next;
      });

      for (const [id, { endpoint, frames }] of byChannel) {
        for (const frame of frames) addTraffic(id, frame.dir, frame.payload.length);
        void StreamAPI.dropped(endpoint)
          .then((dropped) => {
            setDroppedByChannel((previous) =>
              previous[id] === dropped ? previous : { ...previous, [id]: dropped },
            );
          })
          .catch(() => {});
      }
    });
  }, [addTraffic, channels]);

  // Framing failures are cumulative and non-fatal; keep the latest status
  // visible without turning a noisy stream into a toast flood.
  useEffect(() => {
    if (!isHostAvailable()) return;
    return events.streamErrors.on((error: FramingError) => {
      const channel = channels.find((item) => item.endpoint === error.channel);
      if (channel === undefined) return;
      setFramingErrorsByChannel((previous) => ({ ...previous, [channel.id]: error }));
    });
  }, [channels]);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const handleSend = useCallback(
    async (payload: SendPayload) => {
      if (active === null || active.kind !== "serial") return;
      const id = active.id;
      const portName = active.endpoint;
      const { wire, bytes, error } = toWireString(payload);
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
          [id]: appendFrames(prev[id] ?? EMPTY_FRAME_BUFFER, [
            {
              dir: "out",
              payload: new Uint8Array(),
              ts: Date.now(),
              error: `Send failed: ${message}`,
            },
          ]),
        }));
        setSendError(message);
        toast.error(`Send to ${portName} failed`, { description: message });
        return;
      } finally {
        setSending(false);
      }
      addTraffic(id, "out", bytes.length);
      setFramesByChannel((prev) => ({
        ...prev,
        [id]: appendFrames(prev[id] ?? EMPTY_FRAME_BUFFER, [
          { dir: "out", payload: bytes, ts: Date.now() },
        ]),
      }));
    },
    [active, addTraffic],
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
    setFramesByChannel((prev) => ({ ...prev, [id]: EMPTY_FRAME_BUFFER }));
    setFrameSelection(null);
  }, [active]);

  // Create adds a channel only after the backend accepts the connection.
  // Edit keeps the stable frontend id and rolls back a failed same-endpoint
  // reopen to the last successful config.
  const handleChannelSubmit = useCallback(
    async (value: ChannelFormValue) => {
      if (!isHostAvailable()) throw new Error("No Go host: cannot open channels in browser mode.");
      const endpoint = value.port.trim();
      const config = configFromForm(value);
      if (channelDialog === null || channelDialog.mode === "create") {
        const id = createChannelId("serial");
        addChannel({
          id,
          name: endpoint,
          endpoint,
          kind: "serial",
          state: "connecting",
          config,
        });
        try {
          await SerialService.open(openRequest(endpoint, config));
          updateChannel(id, { state: "connected", error: undefined });
        } catch (error) {
          removeChannel(id);
          throw error;
        }
        return;
      }

      const existing = channels.find((channel) => channel.id === channelDialog.id);
      if (existing === undefined) throw new Error("Channel is no longer available.");

      if (existing.endpoint === endpoint) {
        updateChannel(existing.id, { state: "connecting", error: undefined });
        try {
          await SerialService.close(endpoint).catch((error: unknown) => {
            if (!isNotOpenError(error)) throw error;
          });
        } catch (error) {
          updateChannel(existing.id, { state: "error", error: messageOf(error) });
          throw error;
        }
        try {
          await SerialService.open(openRequest(endpoint, config));
          updateChannel(existing.id, {
            name: endpoint,
            endpoint,
            config,
            state: "connected",
            error: undefined,
          });
          selectChannel(existing.id);
          return;
        } catch (openError) {
          try {
            await SerialService.open(openRequest(existing.endpoint, existing.config));
            updateChannel(existing.id, { state: "connected", error: undefined });
          } catch (rollbackError) {
            updateChannel(existing.id, {
              state: "error",
              error: `${messageOf(openError)}; rollback failed: ${messageOf(rollbackError)}`,
            });
            throw new Error(
              `${messageOf(openError)}; rollback failed: ${messageOf(rollbackError)}`,
            );
          }
          updateChannel(existing.id, { state: "connected", error: undefined });
          throw openError;
        }
      }

      // Different endpoints can be opened before the old one closes.
      await SerialService.open(openRequest(endpoint, config));
      try {
        await SerialService.close(existing.endpoint).catch((error: unknown) => {
          if (!isNotOpenError(error)) throw error;
        });
      } catch (closeError) {
        await SerialService.close(endpoint).catch(() => {});
        updateChannel(existing.id, { state: "error", error: messageOf(closeError) });
        throw new Error(
          `New endpoint opened, but the previous endpoint could not close: ${messageOf(closeError)}`,
        );
      }
      updateChannel(existing.id, {
        name: endpoint,
        endpoint,
        config,
        state: "connected",
        error: undefined,
      });
      selectChannel(existing.id);
    },
    [addChannel, channelDialog, channels, removeChannel, selectChannel, updateChannel],
  );

  const handleCloseChannel = useCallback(
    async (id: string) => {
      const channel = channels.find((item) => item.id === id);
      if (channel === undefined) return;
      try {
        await SerialService.close(channel.endpoint);
      } catch (error) {
        if (!isNotOpenError(error)) {
          updateChannel(id, { state: "error", error: messageOf(error) });
          toast.error(`Close ${channel.name} failed`, { description: messageOf(error) });
          return;
        }
      }
      const remaining = channels.filter((item) => item.id !== id);
      removeChannel(id);
      setFramesByChannel((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
      setDroppedByChannel((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
      setFramingErrorsByChannel((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
      if (activeId === id && remaining.length > 0) {
        selectChannel((remaining[0] as Channel).id);
      }
    },
    [activeId, channels, removeChannel, selectChannel, updateChannel],
  );

  const handleSavePreset = useCallback(async (name: string, value: ChannelFormValue) => {
    const cleanName = name.trim();
    await ConfigAPI.savePreset(cleanName, presetFromForm(value));
    setPresets((previous) => ({ ...previous, [cleanName]: { ...value } }));
  }, []);

  const handleRenamePreset = useCallback(async (oldName: string, newName: string) => {
    const cleanName = newName.trim();
    await ConfigAPI.renamePreset(oldName, cleanName);
    setPresets((previous) => {
      const value = previous[oldName];
      if (value === undefined) return previous;
      const next = { ...previous };
      delete next[oldName];
      next[cleanName] = value;
      return next;
    });
  }, []);

  const handleDeletePreset = useCallback(async (name: string) => {
    await ConfigAPI.deletePreset(name);
    setPresets((previous) => {
      const next = { ...previous };
      delete next[name];
      return next;
    });
  }, []);

  const dialogPorts = useMemo(
    () =>
      ports
        .map((port) => port.name)
        .filter(
          (name) =>
            !channels.some((channel) => channel.kind === "serial" && channel.endpoint === name),
        ),
    [channels, ports],
  );
  const dialogInitial = useMemo<ChannelFormValue | null>(() => {
    if (channelDialog === null || channelDialog.mode === "create") return null;
    const ch = channels.find((c) => c.id === channelDialog.id);
    if (!ch) return null;
    return formFromChannel(ch);
  }, [channelDialog, channels]);

  return (
    <HintsProvider>
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
        <WorkbenchHeader
          view={mainView}
          onViewChange={setMainView}
          channel={active}
          onAddChannel={() => setChannelDialog({ mode: "create" })}
        />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {mainView === "monitor" && (
            <Sidebar
              channels={channels}
              activeId={activeId}
              loading={portsLoading}
              listError={listError}
              onSelect={selectChannel}
              onAdd={() => setChannelDialog({ mode: "create" })}
              onEdit={(id) => setChannelDialog({ mode: "edit", id })}
              onClose={(id) => void handleCloseChannel(id)}
            />
          )}

          <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {mainView === "monitor" ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col xl:flex-row">
                <FramePanel
                  channelName={active?.name ?? null}
                  frames={
                    active !== null ? (framesByChannel[active.id] ?? EMPTY_FRAME_BUFFER).frames : []
                  }
                  onSelectFrame={(frame, index) => {
                    setFrameSelection({ frame, index });
                    setDockTab("inspect");
                  }}
                  onClear={handleClear}
                />

                <aside
                  aria-label="Channel operations"
                  className="flex h-[42%] min-h-0 w-full shrink-0 flex-col border-t border-border bg-card xl:h-auto xl:w-80 xl:border-t-0 xl:border-l"
                >
                  <div
                    role="tablist"
                    aria-label="Operations"
                    className="flex h-10 shrink-0 border-b border-border bg-card"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={dockTab === "send"}
                      onClick={() => setDockTab("send")}
                      className={cn(
                        "flex flex-1 items-center justify-center gap-1.5 border-r border-border font-mono text-[9px] tracking-wide uppercase",
                        dockTab === "send"
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <SendHorizontal size={12} aria-hidden="true" />
                      Transmit
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={dockTab === "inspect"}
                      onClick={() => setDockTab("inspect")}
                      className={cn(
                        "flex flex-1 items-center justify-center gap-1.5 font-mono text-[9px] tracking-wide uppercase",
                        dockTab === "inspect"
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <ScanSearch size={12} aria-hidden="true" />
                      Inspect
                      {frameSelection !== null && (
                        <span className="size-1 rounded-full bg-primary" aria-hidden="true" />
                      )}
                    </button>
                  </div>

                  {dockTab === "send" ? (
                    <Composer
                      channelName={active?.name ?? null}
                      canSend={active !== null && active.kind === "serial"}
                      sending={sending}
                      error={sendError}
                      onSend={(payload) => void handleSend(payload)}
                    />
                  ) : (
                    <FrameInspector
                      selection={
                        frameSelection !== null && active !== null
                          ? { frame: frameSelection.frame, channelName: active.name }
                          : null
                      }
                      onClose={() => setFrameSelection(null)}
                    />
                  )}
                </aside>
              </div>
            ) : (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
                <div className="max-h-36 shrink-0 overflow-y-auto border-b border-border bg-card lg:max-h-none lg:w-56 lg:border-r lg:border-b-0">
                  <ScriptLibrary
                    workspaceScripts={DEMO_SCRIPTS}
                    selectedId={selectedScriptId}
                    onSelect={openScriptTab}
                    onRun={handleRun}
                  />
                </div>

                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {openScriptIds.length === 0 ? (
                    <div className="signal-grid grid flex-1 place-items-center bg-card p-6 text-center">
                      <div className="max-w-sm">
                        <span className="mx-auto grid size-12 place-items-center border border-border bg-panel-raised text-muted-foreground">
                          <Code2 size={22} aria-hidden="true" />
                        </span>
                        <p className="mt-4 text-sm font-medium">Open a Lua script</p>
                        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                          Choose a workspace script from the library. Output stays linked beneath
                          the editor.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div
                        role="tablist"
                        aria-label="Open scripts"
                        className="flex h-9 shrink-0 items-center overflow-x-auto border-b border-border bg-panel-raised px-1.5"
                      >
                        {openScriptIds.map((id) => {
                          const entry = DEMO_SCRIPTS.find((script) => script.id === id);
                          const isSelected = id === selectedScriptId;
                          return (
                            <div
                              key={id}
                              role="tab"
                              aria-selected={isSelected}
                              tabIndex={0}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  setSelectedScriptId(id);
                                  setErrorLine(null);
                                }
                              }}
                              className={cn(
                                "flex h-7 items-center gap-1 border border-transparent px-1.5",
                                isSelected && "border-border bg-card",
                              )}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedScriptId(id);
                                  setErrorLine(null);
                                }}
                                className="max-w-40 truncate font-mono text-[10px]"
                              >
                                {entry?.name ?? id}
                              </button>
                              <button
                                type="button"
                                onClick={() => closeScriptTab(id)}
                                aria-label={`Close ${entry?.name ?? id}`}
                                className="grid size-5 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
                              >
                                <X size={11} aria-hidden="true" />
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
                          onChange={(value) => {
                            if (selectedScriptId !== null)
                              setScriptSources((previous) => ({
                                ...previous,
                                [selectedScriptId]: value,
                              }));
                          }}
                          errorLine={errorLine}
                        />
                      </div>

                      <div className="h-44 shrink-0 overflow-hidden border-t border-border bg-card">
                        <ScriptOutput rows={outputRows} onErrorLine={setErrorLine} />
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </main>
        </div>

        <StatusBar
          channel={active}
          onResetCounters={resetCounters}
          dropped={active !== null ? (droppedByChannel[active.id] ?? 0) : 0}
          framingError={active !== null ? framingErrorsByChannel[active.id] : undefined}
        />
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
          onSavePreset={handleSavePreset}
          onRenamePreset={handleRenamePreset}
          onDeletePreset={handleDeletePreset}
        />
      </div>
    </HintsProvider>
  );
}
