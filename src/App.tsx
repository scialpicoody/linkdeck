import {
  AlertTriangle,
  Code2,
  FilePlus2,
  RotateCcw,
  Save,
  ScanSearch,
  SendHorizontal,
  Workflow,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Toaster, toast } from "sonner";
import { SequencePanelView } from "./components/automation";
import type { ChannelFormValue } from "./components/channels";
import {
  ChannelDialog,
  DEFAULT_CHANNEL_FORM,
  framingFormFromPreset,
  framingFormFromSpec,
  toFramingSpec,
} from "./components/channels";
import {
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
import {
  CreateScriptDialog,
  ScriptEditor,
  ScriptLibrary,
  ScriptOutput,
  ScriptRunControls,
} from "./components/scripts";
import { HintsProvider } from "./components/ui/Hint";
import { type AutomationIoCapture, useAutomationController } from "./lib/automation-controller";
import { isAutomationRunActive } from "./lib/automation-projection";
import { EMPTY_CAPTURE_SESSION } from "./lib/capture-session";
import {
  type Channel,
  type ChannelConfig,
  canReconnect,
  channelStateFromStatus,
  createChannelId,
  type NewChannel,
  type SerialChannelConfig,
  useChannels,
} from "./lib/channels";
import {
  clampDockWidth,
  DOCK_DEFAULT_WIDTH,
  DOCK_STORAGE_KEY,
  dockBounds,
  parseStoredDockWidth,
  widthFromKey,
  widthFromPointer,
} from "./lib/dock-layout";
import { createFrame } from "./lib/frame-identity";
import { sessionErrors, throughputSeries } from "./lib/frame-stats";
import { isHostAvailable } from "./lib/host";
import { appendScriptOutput, outputForScript, scriptOutputFromHost } from "./lib/script-output";
import {
  entryFromWorkspaceFile,
  isScriptDirty,
  liveFavorites,
  nextTabAfterClose,
  type ScriptTab,
  tabFromDocument,
} from "./lib/script-workspace";
import { useCaptureSessions } from "./lib/use-capture-sessions";
import { cn } from "./lib/utils";
import {
  AutomationAPI,
  ConfigAPI,
  events,
  type OutputRow as HostScriptOutputRow,
  type OpenRequest,
  type Preset,
  type RunInfo,
  ScriptAPI,
  SerialService,
  type SessionInfo,
  TcpService,
  type TransportStatus,
  WorkspaceAPI,
  type WorkspaceFile,
} from "./mygo";

function configFromForm(value: ChannelFormValue): ChannelConfig {
  if (value.transport === "tcp-client") {
    return {
      transport: "tcp-client",
      address: value.address.trim(),
      connectTimeoutMs: value.connectTimeoutMs,
      reconnectEnabled: value.reconnectEnabled,
      reconnectInitialMs: value.reconnectInitialMs,
      reconnectMaxMs: value.reconnectMaxMs,
      reconnectMaxAttempts: value.reconnectMaxAttempts,
      heartbeatMs: value.heartbeatMs,
      heartbeatPayload: value.heartbeatPayload,
      framing: toFramingSpec(value),
    };
  }
  if (value.transport === "tcp-server") {
    return {
      transport: "tcp-server",
      address: value.address.trim(),
      framing: toFramingSpec(value),
    };
  }
  return {
    transport: "serial",
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
    stream: true,
  };
}

function presetFromForm(value: ChannelFormValue): Preset {
  return {
    Transport: value.transport,
    Endpoint: value.transport === "serial" ? value.port.trim() : value.address.trim(),
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
    ConnectTimeoutMs: value.connectTimeoutMs,
    HeartbeatMs: value.heartbeatMs,
    HeartbeatPayload: value.heartbeatPayload,
    Reconnect: {
      Enabled: value.reconnectEnabled,
      InitialMs: value.reconnectInitialMs,
      MaxMs: value.reconnectMaxMs,
      MaxAttempts: value.reconnectMaxAttempts,
    },
  };
}

function formFromChannel(channel: Channel): ChannelFormValue {
  const config = channel.config;
  if (config.transport === "tcp-client") {
    return {
      ...DEFAULT_CHANNEL_FORM,
      transport: "tcp-client",
      address: config.address,
      connectTimeoutMs: config.connectTimeoutMs,
      reconnectEnabled: config.reconnectEnabled,
      reconnectInitialMs: config.reconnectInitialMs,
      reconnectMaxMs: config.reconnectMaxMs,
      reconnectMaxAttempts: config.reconnectMaxAttempts,
      heartbeatMs: config.heartbeatMs,
      heartbeatPayload: config.heartbeatPayload,
      ...framingFormFromSpec(config.framing),
    };
  }
  if (config.transport === "tcp-server") {
    return {
      ...DEFAULT_CHANNEL_FORM,
      transport: "tcp-server",
      address: config.address,
      ...framingFormFromSpec(config.framing),
    };
  }
  if (config.transport === "tcp-accepted") {
    return {
      ...DEFAULT_CHANNEL_FORM,
      transport: "tcp-server",
      address: channel.endpoint,
      ...framingFormFromSpec(config.framing),
    };
  }
  return {
    ...DEFAULT_CHANNEL_FORM,
    transport: "serial",
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

function heartbeatBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Open one form submission and return the authoritative channel fields. */
async function openConfiguredChannel(
  id: string,
  value: ChannelFormValue,
): Promise<Omit<NewChannel, "id">> {
  const config = configFromForm(value);
  if (config.transport === "serial") {
    const endpoint = value.port.trim();
    await SerialService.open(openRequest(endpoint, config));
    return {
      name: endpoint,
      endpoint,
      backendKey: endpoint,
      kind: "serial",
      config,
      state: "connected",
    };
  }
  if (config.transport === "tcp-server") {
    const info = await TcpService.listen({
      name: id,
      address: config.address,
      framing: config.framing,
      stream: true,
    });
    const saved: ChannelConfig = { ...config, address: info.address };
    return {
      name: info.address,
      endpoint: info.address,
      backendKey: info.name,
      kind: "tcp-server",
      config: saved,
      state: "listening",
    };
  }
  if (config.transport !== "tcp-client") {
    throw new Error("Accepted TCP connections cannot be opened directly.");
  }
  const info = await TcpService.open({
    name: id,
    address: config.address,
    connectTimeoutMs: config.connectTimeoutMs,
    maxRetries: config.reconnectEnabled ? config.reconnectMaxAttempts : -1,
    baseBackoffMs: config.reconnectInitialMs,
    maxBackoffMs: config.reconnectMaxMs,
    heartbeatMs: config.heartbeatMs,
    heartbeatPayload: heartbeatBase64(config.heartbeatPayload),
    framing: config.framing,
    stream: true,
  });
  return {
    name: config.address,
    endpoint: info.address || config.address,
    backendKey: info.name || id,
    kind: "tcp-client",
    config,
    state: channelStateFromStatus("tcp-client", info.state),
  };
}

async function reopenSavedChannel(id: string, channel: Channel): Promise<Omit<NewChannel, "id">> {
  return openConfiguredChannel(id, formFromChannel(channel));
}

async function closeChannelTransport(channel: Channel): Promise<void> {
  if (channel.config.transport === "serial") {
    await SerialService.close(channel.endpoint);
    return;
  }
  if (channel.config.transport === "tcp-client") {
    await TcpService.close(channel.backendKey);
    return;
  }
  if (channel.config.transport === "tcp-server") {
    await TcpService.unlisten(channel.backendKey);
    return;
  }
  await TcpService.serverClose(channel.config.parentKey, channel.backendKey);
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
    addChannel,
    updateChannel,
    removeChannel,
    applyTransportStatus,
  } = useChannels();
  const {
    captures,
    activeCapture,
    markRead,
    clearFrames,
    resetCounters,
    remove: removeCaptures,
    recordFrame,
    recordSent,
    recordFailedSend,
  } = useCaptureSessions(channels, activeId);
  const handleAutomationIo = useCallback(
    (io: AutomationIoCapture) => {
      const channel = channels.find((item) => item.backendKey === io.channel);
      if (channel === undefined) return;
      const frame = createFrame({
        dir: io.direction === "tx" ? "out" : "in",
        payload: io.payload,
        ts: io.tsMillis,
      });
      if (io.error !== undefined) {
        recordFailedSend(channel.id, { ...frame, error: io.error });
      } else {
        recordFrame(channel.id, frame);
      }
    },
    [channels, recordFailedSend, recordFrame],
  );
  const automationController = useAutomationController({ onIoCapture: handleAutomationIo });
  const [statsClock, setStatsClock] = useState(() => Date.now());
  // Selected Frame → slide-over inspector (#20). Cleared on channel switch.
  const [frameSelection, setFrameSelection] = useState<Frame | null>(null);
  const [mainView, setMainView] = useState<MainView>("monitor");
  const [dockTab, setDockTab] = useState<"send" | "sequence" | "inspect">("send");
  const [dockWidth, setDockWidth] = useState(() => {
    const viewport = typeof window === "undefined" ? 1280 : window.innerWidth;
    try {
      return parseStoredDockWidth(localStorage.getItem(DOCK_STORAGE_KEY), viewport);
    } catch {
      return parseStoredDockWidth(null, viewport);
    }
  });
  const dockDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  // Scripts view: real workspace files, persisted favorites, and per-file
  // editor tabs. Revisions detect external edits before a save overwrites.
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [openScriptIds, setOpenScriptIds] = useState<string[]>([]);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [scriptTabs, setScriptTabs] = useState<Record<string, ScriptTab>>({});
  const [scriptSaving, setScriptSaving] = useState(false);
  const [scriptConflict, setScriptConflict] = useState<string | null>(null);
  const [createScriptOpen, setCreateScriptOpen] = useState(false);
  const [scriptTimeoutMs, setScriptTimeoutMs] = useState(5000);
  const [scriptFunctionName, setScriptFunctionName] = useState("main");
  const [scriptRunBusy, setScriptRunBusy] = useState(false);
  const [runsById, setRunsById] = useState<Record<string, RunInfo>>({});
  const [latestRunByScript, setLatestRunByScript] = useState<Record<string, string>>({});
  const [sessionsByPath, setSessionsByPath] = useState<Record<string, SessionInfo>>({});
  const [outputRows, setOutputRows] = useState<ScriptOutputRow[]>([]);
  const [errorLine, setErrorLine] = useState<number | null>(null);
  // Channel dialog: null = closed; {mode:"create"} or {mode:"edit", id}.
  const [channelDialog, setChannelDialog] = useState<
    { mode: "create" } | { mode: "edit"; id: string } | null
  >(null);
  const [presets, setPresets] = useState<Record<string, ChannelFormValue>>({});

  useEffect(() => {
    const timer = window.setInterval(() => setStatsClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DOCK_STORAGE_KEY, String(dockWidth));
    } catch {
      // Persistence is best-effort in restricted webviews.
    }
  }, [dockWidth]);

  useEffect(() => {
    function onResize() {
      setDockWidth((current) => clampDockWidth(current, window.innerWidth));
    }
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, []);

  // Load named presets once (browser-only mode: none).
  useEffect(() => {
    if (!isHostAvailable()) return;
    ConfigAPI.presets()
      .then((all: Record<string, Preset>) => {
        const mapped: Record<string, ChannelFormValue> = {};
        for (const [name, p] of Object.entries(all)) {
          const transport =
            p.Transport === "tcp-server"
              ? "tcp-server"
              : p.Transport === "tcp" || p.Transport === "tcp-client"
                ? "tcp-client"
                : "serial";
          mapped[name] = {
            ...DEFAULT_CHANNEL_FORM,
            ...framingFormFromPreset(p.Framing),
            transport,
            port: transport === "serial" ? p.Endpoint : "",
            address: transport === "serial" ? DEFAULT_CHANNEL_FORM.address : p.Endpoint,
            baudRate: p.Baud,
            dataBits: (p.DataBits === 5 || p.DataBits === 6 || p.DataBits === 7
              ? p.DataBits
              : 8) as ChannelFormValue["dataBits"],
            parity: (p.Parity ?? "none") as ChannelFormValue["parity"],
            stopBits: (p.StopBits ?? "1") as ChannelFormValue["stopBits"],
            readTimeoutMs: p.ReadTimeoutMs ?? 0,
            connectTimeoutMs: p.ConnectTimeoutMs ?? 5000,
            heartbeatMs: p.HeartbeatMs ?? 0,
            heartbeatPayload: p.HeartbeatPayload ?? "",
            reconnectEnabled: p.Reconnect.Enabled,
            reconnectInitialMs: p.Reconnect.InitialMs || 100,
            reconnectMaxMs: p.Reconnect.MaxMs || 5000,
            reconnectMaxAttempts: p.Reconnect.MaxAttempts,
          };
        }
        setPresets(mapped);
      })
      .catch(() => {});
  }, []);

  const refreshWorkspace = useCallback(async (): Promise<WorkspaceFile[]> => {
    if (!isHostAvailable()) return [];
    setWorkspaceLoading(true);
    try {
      const files = await WorkspaceAPI.list();
      setWorkspaceFiles(files);
      setWorkspaceError(null);
      setFavorites((previous) => {
        const cleaned = liveFavorites(previous, files);
        if (cleaned.length !== previous.length) {
          void ConfigAPI.setFavorites(cleaned).catch(() => {});
        }
        return cleaned;
      });
      return files;
    } catch (error) {
      setWorkspaceError(messageOf(error));
      throw error;
    } finally {
      setWorkspaceLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isHostAvailable()) return;
    let cancelled = false;
    void Promise.all([WorkspaceAPI.list(), ConfigAPI.favorites()])
      .then(([files, savedFavorites]) => {
        if (cancelled) return;
        setWorkspaceFiles(files);
        setWorkspaceError(null);
        const cleaned = liveFavorites(savedFavorites, files);
        setFavorites(cleaned);
        if (cleaned.length !== savedFavorites.length) {
          void ConfigAPI.setFavorites(cleaned).catch(() => {});
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setWorkspaceError(messageOf(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isHostAvailable()) return;
    const offOutput = events.scriptOutput.on((hostRow: HostScriptOutputRow) => {
      const row = scriptOutputFromHost(hostRow);
      if (row === null) return;
      setOutputRows((previous) => appendScriptOutput(previous, [row]));
    });
    const offStatus = events.scriptRunStatus.on((info: RunInfo) => {
      setRunsById((previous) => ({ ...previous, [info.id]: info }));
      setLatestRunByScript((previous) => ({ ...previous, [info.script]: info.id }));
    });
    void ScriptAPI.sessions()
      .then((sessions) => {
        setSessionsByPath(Object.fromEntries(sessions.map((session) => [session.path, session])));
      })
      .catch(() => {});
    return () => {
      offOutput();
      offStatus();
    };
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

  useEffect(() => {
    if (!isHostAvailable()) return;
    return events.channelStatus.on((statuses: TransportStatus[]) => {
      applyTransportStatus(statuses);
    });
  }, [applyTransportStatus]);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const handleSend = useCallback(
    async (payload: SendPayload) => {
      if (active === null || active.kind === "tcp-server") return;
      const id = active.id;
      const target = active.name;
      const { wire, bytes, error } = toWireString(payload);
      if (error !== null) {
        setSendError(error);
        return;
      }
      setSending(true);
      setSendError(null);
      try {
        if (active.config.transport === "serial") {
          await SerialService.send(active.endpoint, wire);
        } else if (active.config.transport === "tcp-client") {
          await TcpService.send(active.backendKey, wire);
        } else if (active.config.transport === "tcp-accepted") {
          await TcpService.serverSend(active.config.parentKey, active.backendKey, wire);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // TX failure: red row in the frame table (not the script output) +
        // inline composer error + toast. No dependency on Output visibility.
        recordFailedSend(
          id,
          createFrame({
            dir: "out",
            payload: new Uint8Array(),
            ts: Date.now(),
            error: `Send failed: ${message}`,
          }),
        );
        setSendError(message);
        toast.error(`Send to ${target} failed`, { description: message });
        return;
      } finally {
        setSending(false);
      }
      const sentFrame = createFrame({ dir: "out", payload: bytes, ts: Date.now() });
      recordSent(id, sentFrame);
    },
    [active, recordFailedSend, recordSent],
  );

  const rememberRun = useCallback((info: RunInfo) => {
    setRunsById((previous) => ({ ...previous, [info.id]: info }));
    setLatestRunByScript((previous) => ({ ...previous, [info.script]: info.id }));
  }, []);

  const handleRun = useCallback(
    async (script: ScriptEntry): Promise<void> => {
      if (!isHostAvailable()) {
        toast.error("No Go host: script runs are unavailable in browser mode.");
        return;
      }
      setScriptRunBusy(true);
      try {
        const info = await ScriptAPI.startFile(script.path, scriptTimeoutMs);
        rememberRun(info);
      } catch (error) {
        toast.error(`Run ${script.name} failed`, { description: messageOf(error) });
      } finally {
        setScriptRunBusy(false);
      }
    },
    [rememberRun, scriptTimeoutMs],
  );

  const showScriptDocument = useCallback((tab: ScriptTab) => {
    setScriptTabs((previous) => ({ ...previous, [tab.id]: tab }));
    setOpenScriptIds((previous) => (previous.includes(tab.id) ? previous : [...previous, tab.id]));
    setSelectedScriptId(tab.id);
    setScriptConflict(null);
    setErrorLine(null);
  }, []);

  async function openScriptTab(script: ScriptEntry): Promise<void> {
    if (scriptTabs[script.id] !== undefined) {
      setSelectedScriptId(script.id);
      setScriptConflict(null);
      setErrorLine(null);
      return;
    }
    try {
      const doc = await WorkspaceAPI.read(script.path);
      showScriptDocument(tabFromDocument(doc));
    } catch (error) {
      toast.error(`Open ${script.name} failed`, { description: messageOf(error) });
    }
  }

  function closeScriptTab(id: string): void {
    const tab = scriptTabs[id];
    if (tab !== undefined && isScriptDirty(tab)) {
      const discard = window.confirm(`Discard unsaved changes in ${tab.name}?`);
      if (!discard) return;
    }
    const next = nextTabAfterClose(openScriptIds, id);
    setOpenScriptIds((previous) => previous.filter((openId) => openId !== id));
    setScriptTabs((previous) => {
      const copy = { ...previous };
      delete copy[id];
      return copy;
    });
    if (selectedScriptId === id) {
      setSelectedScriptId(next);
      setScriptConflict(null);
      setErrorLine(null);
    }
  }

  async function createScript(name: string): Promise<void> {
    const doc = await WorkspaceAPI.create(name);
    await refreshWorkspace();
    showScriptDocument(tabFromDocument(doc));
  }

  async function saveActiveScript(): Promise<void> {
    if (selectedScriptId === null) return;
    const tab = scriptTabs[selectedScriptId];
    if (tab === undefined) return;
    setScriptSaving(true);
    setScriptConflict(null);
    try {
      const saved = await WorkspaceAPI.write(tab.path, tab.source, tab.revision);
      const next = tabFromDocument(saved);
      setScriptTabs((previous) => ({ ...previous, [next.id]: next }));
      await refreshWorkspace();
      toast.success(`${next.name} saved`);
    } catch (error) {
      const message = messageOf(error);
      if (/changed on disk|conflict/i.test(message)) {
        setScriptConflict(
          `${tab.name} changed on disk. Reload it or copy your edits before saving again.`,
        );
      } else {
        toast.error(`Save ${tab.name} failed`, { description: message });
      }
    } finally {
      setScriptSaving(false);
    }
  }

  async function reloadActiveScript(): Promise<void> {
    if (selectedScriptId === null) return;
    const tab = scriptTabs[selectedScriptId];
    if (tab === undefined) return;
    if (isScriptDirty(tab) && !window.confirm(`Discard unsaved changes in ${tab.name}?`)) return;
    try {
      const doc = await WorkspaceAPI.read(tab.path);
      showScriptDocument(tabFromDocument(doc));
      await refreshWorkspace();
    } catch (error) {
      toast.error(`Reload ${tab.name} failed`, { description: messageOf(error) });
    }
  }

  function updateFavorites(next: string[]): void {
    const previous = favorites;
    setFavorites(next);
    void ConfigAPI.setFavorites(next).catch((error: unknown) => {
      setFavorites(previous);
      toast.error("Favorite save failed", { description: messageOf(error) });
    });
  }

  const activeScript = selectedScriptId === null ? null : (scriptTabs[selectedScriptId] ?? null);
  const activeRunId = activeScript === null ? undefined : latestRunByScript[activeScript.path];
  const activeRun = activeRunId === undefined ? null : (runsById[activeRunId] ?? null);
  const activeSession = activeScript === null ? null : (sessionsByPath[activeScript.path] ?? null);
  const activeOutputRows =
    activeScript === null ? [] : outputForScript(outputRows, activeScript.path);

  async function runActiveSource(): Promise<void> {
    if (activeScript === null) return;
    setScriptRunBusy(true);
    try {
      const info = await ScriptAPI.startRun(
        activeScript.source,
        activeScript.path,
        scriptTimeoutMs,
      );
      rememberRun(info);
    } catch (error) {
      toast.error(`Run ${activeScript.name} failed`, { description: messageOf(error) });
    } finally {
      setScriptRunBusy(false);
    }
  }

  async function runActiveFile(): Promise<void> {
    if (activeScript === null) return;
    setScriptRunBusy(true);
    try {
      const info = await ScriptAPI.startFile(activeScript.path, scriptTimeoutMs);
      rememberRun(info);
    } catch (error) {
      toast.error(`Run ${activeScript.name} failed`, { description: messageOf(error) });
    } finally {
      setScriptRunBusy(false);
    }
  }

  async function cancelActiveRun(): Promise<void> {
    if (activeRun === null) return;
    try {
      // The final cancelled status arrives on the status event; no local
      // optimistic transition can masquerade as a completed run.
      await ScriptAPI.cancelRun(activeRun.id);
    } catch (error) {
      toast.error("Cancel run failed", { description: messageOf(error) });
    }
  }

  async function loadActiveSession(): Promise<void> {
    if (activeScript === null) return;
    setScriptRunBusy(true);
    try {
      const session = await ScriptAPI.loadSession(activeScript.path);
      setSessionsByPath((previous) => ({ ...previous, [session.path]: session }));
      toast.success(`Session loaded for ${activeScript.name}`);
    } catch (error) {
      toast.error("Load session failed", { description: messageOf(error) });
    } finally {
      setScriptRunBusy(false);
    }
  }

  async function callActiveSession(): Promise<void> {
    if (activeScript === null || activeSession === null) return;
    setScriptRunBusy(true);
    try {
      const info = await ScriptAPI.callSession(
        activeScript.path,
        scriptFunctionName.trim(),
        scriptTimeoutMs,
      );
      rememberRun(info);
    } catch (error) {
      toast.error("Session call failed", { description: messageOf(error) });
    } finally {
      setScriptRunBusy(false);
    }
  }

  async function closeActiveSession(): Promise<void> {
    if (activeScript === null) return;
    try {
      await ScriptAPI.closeSession(activeScript.path);
      setSessionsByPath((previous) => {
        const next = { ...previous };
        delete next[activeScript.path];
        return next;
      });
      toast.success(`Session closed for ${activeScript.name}`);
    } catch (error) {
      toast.error("Close session failed", { description: messageOf(error) });
    }
  }

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!Object.values(scriptTabs).some(isScriptDirty)) return;
      event.preventDefault();
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [scriptTabs]);

  const handleClear = useCallback(() => {
    if (active === null) return;
    clearFrames(active.id);
    setFrameSelection(null);
  }, [active, clearFrames]);

  const removeChannelArtifacts = useCallback(
    (ids: string[]) => {
      for (const id of ids) removeChannel(id);
      removeCaptures(ids);
    },
    [removeCaptures, removeChannel],
  );

  const cancelAutomationFor = useCallback((items: Channel[]) => {
    for (const item of items) {
      void AutomationAPI.cancelChannel(item.backendKey).catch(() => {});
    }
  }, []);

  // Create adds a channel only after the backend accepts the connection.
  // Edit keeps the stable frontend id, opens a different backend before
  // closing the old one, and rolls back same-backend reopen failures.
  const handleChannelSubmit = useCallback(
    async (value: ChannelFormValue) => {
      if (!isHostAvailable()) throw new Error("No Go host: cannot open channels in browser mode.");
      if (channelDialog === null || channelDialog.mode === "create") {
        const id = createChannelId(value.transport);
        const opened = await openConfiguredChannel(id, value);
        addChannel({
          id,
          ...opened,
        });
        return;
      }

      const existing = channels.find((channel) => channel.id === channelDialog.id);
      if (existing === undefined) throw new Error("Channel is no longer available.");
      if (existing.kind === "tcp-accepted") {
        throw new Error("Accepted TCP connections inherit their server settings.");
      }
      const ownedAcceptedIds =
        existing.kind === "tcp-server"
          ? channels
              .filter(
                (channel) =>
                  channel.kind === "tcp-accepted" &&
                  channel.config.transport === "tcp-accepted" &&
                  channel.config.parentKey === existing.backendKey,
              )
              .map((channel) => channel.id)
          : [];
      const acceptedChannels = channels.filter((channel) => ownedAcceptedIds.includes(channel.id));
      cancelAutomationFor([existing, ...acceptedChannels]);

      const nextConfig = configFromForm(value);
      const nextBackendKey = nextConfig.transport === "serial" ? value.port.trim() : existing.id;
      if (nextBackendKey === existing.backendKey) {
        updateChannel(existing.id, { state: "connecting", error: undefined });
        try {
          await closeChannelTransport(existing).catch((error: unknown) => {
            if (!isNotOpenError(error)) throw error;
          });
        } catch (error) {
          updateChannel(existing.id, { state: "error", error: messageOf(error) });
          throw error;
        }
        try {
          const opened = await openConfiguredChannel(existing.id, value);
          updateChannel(existing.id, {
            ...opened,
            error: undefined,
          });
          if (ownedAcceptedIds.length > 0) removeChannelArtifacts(ownedAcceptedIds);
          selectChannel(existing.id);
          return;
        } catch (openError) {
          try {
            const restored = await reopenSavedChannel(existing.id, existing);
            updateChannel(existing.id, {
              ...restored,
              state: "connected",
              error: undefined,
            });
          } catch (rollbackError) {
            updateChannel(existing.id, {
              state: "error",
              error: `${messageOf(openError)}; rollback failed: ${messageOf(rollbackError)}`,
            });
            throw new Error(
              `${messageOf(openError)}; rollback failed: ${messageOf(rollbackError)}`,
            );
          }
          throw openError;
        }
      }

      // Different backend keys can be opened before the old one closes.
      const opened = await openConfiguredChannel(existing.id, value);
      try {
        await closeChannelTransport(existing).catch((error: unknown) => {
          if (!isNotOpenError(error)) throw error;
        });
      } catch (closeError) {
        await closeChannelTransport({
          ...existing,
          ...opened,
          config: opened.config,
        }).catch(() => {});
        updateChannel(existing.id, { state: "error", error: messageOf(closeError) });
        throw new Error(
          `New endpoint opened, but the previous endpoint could not close: ${messageOf(closeError)}`,
        );
      }
      updateChannel(existing.id, {
        ...opened,
        error: undefined,
      });
      if (ownedAcceptedIds.length > 0) removeChannelArtifacts(ownedAcceptedIds);
      selectChannel(existing.id);
    },
    [
      addChannel,
      cancelAutomationFor,
      channelDialog,
      channels,
      removeChannelArtifacts,
      selectChannel,
      updateChannel,
    ],
  );

  const handleCloseChannel = useCallback(
    async (id: string) => {
      const channel = channels.find((item) => item.id === id);
      if (channel === undefined) return;
      const ownedAcceptedIds =
        channel.kind === "tcp-server"
          ? channels
              .filter(
                (candidate) =>
                  candidate.kind === "tcp-accepted" &&
                  candidate.config.transport === "tcp-accepted" &&
                  candidate.config.parentKey === channel.backendKey,
              )
              .map((candidate) => candidate.id)
          : [];
      const acceptedChannels = channels.filter((candidate) =>
        ownedAcceptedIds.includes(candidate.id),
      );
      cancelAutomationFor([channel, ...acceptedChannels]);
      try {
        await closeChannelTransport(channel);
      } catch (error) {
        if (!isNotOpenError(error)) {
          updateChannel(id, { state: "error", error: messageOf(error) });
          toast.error(`Close ${channel.name} failed`, { description: messageOf(error) });
          return;
        }
      }
      const remaining = channels.filter((item) => item.id !== id);
      removeChannelArtifacts([id, ...ownedAcceptedIds]);
      const remainingAfterOwned = remaining.filter((item) => !ownedAcceptedIds.includes(item.id));
      if (
        (activeId === id || (activeId !== null && ownedAcceptedIds.includes(activeId))) &&
        remainingAfterOwned.length > 0
      ) {
        selectChannel((remainingAfterOwned[0] as Channel).id);
      }
    },
    [activeId, cancelAutomationFor, channels, removeChannelArtifacts, selectChannel, updateChannel],
  );

  const handleReconnectChannel = useCallback(
    async (id: string) => {
      const channel = channels.find((item) => item.id === id);
      if (channel === undefined || !canReconnect(channel)) return;
      const ownedAcceptedIds =
        channel.kind === "tcp-server"
          ? channels
              .filter(
                (candidate) =>
                  candidate.kind === "tcp-accepted" &&
                  candidate.config.transport === "tcp-accepted" &&
                  candidate.config.parentKey === channel.backendKey,
              )
              .map((candidate) => candidate.id)
          : [];
      const acceptedChannels = channels.filter((candidate) =>
        ownedAcceptedIds.includes(candidate.id),
      );
      cancelAutomationFor([channel, ...acceptedChannels]);

      updateChannel(id, { state: "connecting", error: undefined, attempts: 0 });
      try {
        await closeChannelTransport(channel).catch((error: unknown) => {
          if (!isNotOpenError(error)) throw error;
        });
        if (ownedAcceptedIds.length > 0) removeChannelArtifacts(ownedAcceptedIds);
        const opened = await reopenSavedChannel(id, channel);
        updateChannel(id, {
          ...opened,
          attempts: 0,
          error: undefined,
        });
        selectChannel(id);
        if (opened.state === "reconnecting") {
          toast.info(`Reconnecting ${opened.name}`);
        } else {
          toast.success(`Reopened ${opened.name}`);
        }
      } catch (error) {
        updateChannel(id, { state: "error", error: messageOf(error), attempts: 0 });
        toast.error(`Reconnect ${channel.name} failed`, { description: messageOf(error) });
      }
    },
    [cancelAutomationFor, channels, removeChannelArtifacts, selectChannel, updateChannel],
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
  const activeStats = activeCapture?.stats ?? EMPTY_CAPTURE_SESSION.stats;
  const activeThroughput = throughputSeries(activeStats, statsClock);
  const activeFramingError = activeCapture?.framingError;
  const activeFramingCount = activeFramingError
    ? activeFramingError.oversize + activeFramingError.checksum + activeFramingError.other
    : 0;
  const automationActive = Object.values(automationController.projection.runs).some(
    isAutomationRunActive,
  );
  const dockLimits = dockBounds(typeof window === "undefined" ? 1280 : window.innerWidth);

  function startDockResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    dockDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: dockWidth,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }

  function moveDockResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dockDrag.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    setDockWidth(widthFromPointer(drag.startWidth, drag.startX, event.clientX, window.innerWidth));
  }

  function endDockResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dockDrag.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dockDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }

  function keyDockResize(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const next = widthFromKey(dockWidth, event.key, window.innerWidth);
    if (next === null) return;
    event.preventDefault();
    setDockWidth(next);
  }

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
              captures={captures}
              activeId={activeId}
              loading={portsLoading}
              listError={listError}
              onSelect={selectChannel}
              onAdd={() => setChannelDialog({ mode: "create" })}
              onEdit={(id) => setChannelDialog({ mode: "edit", id })}
              onReconnect={(id) => void handleReconnectChannel(id)}
              onClose={(id) => void handleCloseChannel(id)}
            />
          )}

          <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {mainView === "monitor" ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col xl:flex-row">
                <FramePanel
                  channelName={active?.name ?? null}
                  frames={activeCapture?.frames.frames ?? []}
                  selectedFrame={frameSelection}
                  onSelectFrame={(frame) => {
                    setFrameSelection(frame);
                    setDockTab("inspect");
                  }}
                  onClear={handleClear}
                />

                <aside
                  aria-label="Channel operations"
                  className="operations-dock relative flex min-h-0 shrink-0 flex-col border-t border-border bg-card xl:border-t-0 xl:border-l"
                  style={{ "--dock-width": `${dockWidth}px` } as CSSProperties}
                >
                  <hr
                    aria-label="Resize operations dock"
                    aria-orientation="vertical"
                    aria-valuemin={dockLimits.min}
                    aria-valuemax={dockLimits.max}
                    aria-valuenow={dockWidth}
                    aria-valuetext={`${dockWidth} pixels`}
                    tabIndex={0}
                    onPointerDown={startDockResize}
                    onPointerMove={moveDockResize}
                    onPointerUp={endDockResize}
                    onPointerCancel={endDockResize}
                    onKeyDown={keyDockResize}
                    className="absolute top-0 -left-1 z-20 hidden h-full w-2 cursor-col-resize touch-none border-0 bg-transparent focus-visible:bg-primary/35 focus-visible:outline focus-visible:outline-primary xl:block"
                  />
                  <span
                    className="pointer-events-none absolute inset-y-0 -left-px z-10 hidden w-px bg-border-strong/65 xl:block"
                    aria-hidden="true"
                  />
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
                      aria-selected={dockTab === "sequence"}
                      onClick={() => setDockTab("sequence")}
                      className={cn(
                        "relative flex flex-1 items-center justify-center gap-1.5 border-r border-border font-mono text-[9px] tracking-wide uppercase",
                        dockTab === "sequence"
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <Workflow size={12} aria-hidden="true" />
                      Sequence
                      {automationActive && (
                        <span className="size-1 rounded-full bg-primary" aria-hidden="true" />
                      )}
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
                    <span className="hidden items-center px-1.5 font-mono text-[8px] text-muted-foreground xl:flex">
                      {dockWidth}px
                    </span>
                    <button
                      type="button"
                      title="Reset dock width"
                      onClick={() =>
                        setDockWidth(clampDockWidth(DOCK_DEFAULT_WIDTH, window.innerWidth))
                      }
                      aria-label="Reset operations dock width"
                      className="hidden size-7 shrink-0 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground xl:grid"
                    >
                      <RotateCcw size={11} aria-hidden="true" />
                    </button>
                  </div>

                  <div
                    className={cn("flex min-h-0 flex-1 flex-col", dockTab !== "send" && "hidden")}
                  >
                    <Composer
                      channelName={active?.name ?? null}
                      canSend={active !== null && active.kind !== "tcp-server"}
                      sending={sending}
                      error={sendError}
                      onSend={(payload) => void handleSend(payload)}
                    />
                  </div>
                  <div
                    className={cn(
                      "flex min-h-0 flex-1 flex-col",
                      dockTab !== "sequence" && "hidden",
                    )}
                  >
                    <SequencePanelView
                      channel={active}
                      controller={automationController}
                      onIoCapture={handleAutomationIo}
                    />
                  </div>
                  <div
                    className={cn(
                      "flex min-h-0 flex-1 flex-col",
                      dockTab !== "inspect" && "hidden",
                    )}
                  >
                    <FrameInspector
                      selection={
                        frameSelection !== null && active !== null
                          ? { frame: frameSelection, channelName: active.name }
                          : null
                      }
                      frames={activeCapture?.frames.frames ?? []}
                      onClose={() => setFrameSelection(null)}
                      stats={
                        active === null
                          ? undefined
                          : {
                              frames: activeStats.frames,
                              bytes: activeStats.bytes,
                              errors: sessionErrors(
                                activeStats,
                                activeFramingCount,
                                activeCapture?.dropped ?? 0,
                              ),
                              rx: activeThroughput.rx,
                              tx: activeThroughput.tx,
                            }
                      }
                    />
                  </div>
                </aside>
              </div>
            ) : (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
                <div className="max-h-36 shrink-0 overflow-y-auto border-b border-border bg-card lg:max-h-none lg:w-56 lg:border-r lg:border-b-0">
                  <ScriptLibrary
                    workspaceScripts={workspaceFiles.map(entryFromWorkspaceFile)}
                    favorites={favorites}
                    onFavoritesChange={updateFavorites}
                    selectedId={selectedScriptId}
                    onSelect={(script) => void openScriptTab(script)}
                    onRun={(script) => void handleRun(script)}
                    onCreate={() => setCreateScriptOpen(true)}
                    busyPath={
                      activeRun?.state === "running" || activeRun?.state === "queued"
                        ? activeRun.script
                        : null
                    }
                    error={workspaceError}
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
                          {workspaceLoading
                            ? "Scanning the Lua workspace…"
                            : "Choose a workspace script from the library, or create one. Output stays linked beneath the editor."}
                        </p>
                        {!workspaceLoading && workspaceFiles.length === 0 && (
                          <button
                            type="button"
                            onClick={() => setCreateScriptOpen(true)}
                            className="mt-4 inline-flex h-8 items-center gap-1.5 bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
                          >
                            <FilePlus2 size={13} aria-hidden="true" />
                            Create script
                          </button>
                        )}
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
                          const tab = scriptTabs[id];
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
                                {tab?.name ?? id}
                                {tab !== undefined && isScriptDirty(tab) && (
                                  <span className="ml-1 text-primary">
                                    <span className="sr-only">Unsaved changes</span>●
                                  </span>
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => closeScriptTab(id)}
                                aria-label={`Close ${tab?.name ?? id}`}
                                className="grid size-5 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
                              >
                                <X size={11} aria-hidden="true" />
                              </button>
                            </div>
                          );
                        })}
                      </div>

                      {activeScript !== null && (
                        <ScriptRunControls
                          activeRun={activeRun}
                          session={activeSession}
                          timeoutMs={scriptTimeoutMs}
                          functionName={scriptFunctionName}
                          busy={scriptRunBusy}
                          onTimeoutChange={(value) =>
                            setScriptTimeoutMs(Number.isFinite(value) ? Math.max(1, value) : 5000)
                          }
                          onFunctionNameChange={setScriptFunctionName}
                          onRunSource={() => void runActiveSource()}
                          onRunFile={() => void runActiveFile()}
                          onCancel={() => void cancelActiveRun()}
                          onLoadSession={() => void loadActiveSession()}
                          onCallSession={() => void callActiveSession()}
                          onCloseSession={() => void closeActiveSession()}
                        />
                      )}

                      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-muted-foreground">
                          {activeScript?.path ?? ""}
                        </span>
                        <button
                          type="button"
                          onClick={() => void reloadActiveScript()}
                          className="h-6 border border-border bg-card px-2 font-mono text-[8px] uppercase text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          Reload
                        </button>
                        <button
                          type="button"
                          disabled={
                            activeScript === null || !isScriptDirty(activeScript) || scriptSaving
                          }
                          onClick={() => void saveActiveScript()}
                          className="inline-flex h-6 items-center gap-1 bg-primary px-2 font-mono text-[8px] uppercase text-primary-foreground hover:opacity-90 disabled:opacity-40"
                        >
                          <Save size={10} aria-hidden="true" />
                          {scriptSaving ? "Saving" : "Save"}
                        </button>
                      </div>

                      {scriptConflict !== null && (
                        <div
                          role="alert"
                          className="flex shrink-0 items-start gap-2 border-b border-danger/35 bg-danger/8 px-3 py-2 text-xs text-danger"
                        >
                          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                          <span className="flex-1">{scriptConflict}</span>
                          <button
                            type="button"
                            onClick={() => void reloadActiveScript()}
                            className="shrink-0 border border-danger/40 px-2 py-0.5 font-mono text-[9px] uppercase hover:bg-danger/10"
                          >
                            Reload
                          </button>
                        </div>
                      )}

                      <div className="min-h-0 flex-1">
                        <ScriptEditor
                          value={activeScript?.source ?? ""}
                          onChange={(value) => {
                            if (selectedScriptId === null) return;
                            setScriptTabs((previous) => {
                              const tab = previous[selectedScriptId];
                              if (tab === undefined) return previous;
                              return {
                                ...previous,
                                [selectedScriptId]: { ...tab, source: value },
                              };
                            });
                          }}
                          errorLine={errorLine}
                        />
                      </div>

                      <div className="flex h-48 shrink-0 flex-col overflow-hidden border-t border-border bg-card">
                        <div className="flex h-7 shrink-0 items-center justify-between border-b border-border bg-panel-raised px-2">
                          <span className="eyebrow text-muted-foreground">
                            Script output · {activeOutputRows.length}
                          </span>
                          <button
                            type="button"
                            onClick={() => setOutputRows([])}
                            className="font-mono text-[8px] uppercase text-muted-foreground hover:text-foreground"
                          >
                            Clear
                          </button>
                        </div>
                        <div className="min-h-0 flex-1">
                          <ScriptOutput rows={activeOutputRows} onErrorLine={setErrorLine} />
                        </div>
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
          capture={activeCapture ?? undefined}
          onResetCounters={resetCounters}
        />
        <Toaster position="bottom-right" theme="system" />
        <CreateScriptDialog
          open={createScriptOpen}
          onOpenChange={setCreateScriptOpen}
          onCreate={createScript}
        />
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
