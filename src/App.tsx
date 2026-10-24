import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { type Frame, FramePanel } from "./components/frames";
import { Sidebar } from "./components/layout/Sidebar";
import { StatusBar } from "./components/layout/StatusBar";
import { TabStrip } from "./components/layout/TabStrip";
import type { ScriptEntry, ScriptOutputRow } from "./components/scripts";
import { ScriptEditor, ScriptLibrary, ScriptOutput } from "./components/scripts";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { HintsProvider } from "./components/ui/Hint";
import { useChannels } from "./lib/channels";
import { isHostAvailable } from "./lib/host";
import { events, SerialService } from "./mygo";

// FramePanel is the primary view (sync import: it owns the hot loop).
// InspectorPanel stays lazy until its slide-over lands (#20).
const InspectorPanel = lazy(() =>
  import("./components/inspector").then((m) => ({ default: m.InspectorPanel })),
);

const PANEL_FALLBACK = (
  <div className="grid flex-1 place-items-center text-sm text-muted-foreground">Loading…</div>
);

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
  } = useChannels();
  const [clock, setClock] = useState("--:--:--");
  // Per-channel TX echo frames. RX frames arrive with the framing phase,
  // which feeds this same map through a mygo event.
  const [framesByChannel, setFramesByChannel] = useState<Record<string, Frame[]>>({});
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [scriptSource, setScriptSource] = useState(LUA_STARTER);
  const [outputRows, setOutputRows] = useState<ScriptOutputRow[]>([]);
  const [errorLine, setErrorLine] = useState<number | null>(null);
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);

  useEffect(() => {
    // Without the Go host there is no tick event; fall back to a local clock
    // so the status bar still advances in browser-only mode.
    if (!isHostAvailable()) {
      const timer = setInterval(() => setClock(new Date().toLocaleTimeString()), 1000);
      return () => clearInterval(timer);
    }
    return events.tick.on((time) => {
      setClock(new Date(time).toLocaleTimeString());
    });
  }, []);

  // Clear the unread badge whenever the active channel changes.
  useEffect(() => {
    if (activeId !== null) markRead(activeId);
  }, [activeId, markRead]);
  // Surface port-enumeration failures as a toast (sidebar shows it inline too).
  useEffect(() => {
    if (listError !== null) {
      toast.error("Port refresh failed", { description: listError });
    }
  }, [listError]);

  const handleSend = useCallback(
    async (data: string) => {
      if (active === null || active.kind !== "serial") return;
      const id = active.id;
      const portName = active.name;
      try {
        await SerialService.send(portName, data);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setOutputRows((rows) => [
          ...rows,
          {
            type: "error",
            channel: portName,
            direction: "out",
            data: message,
            ts: Date.now(),
          },
        ]);
        toast.error(`Send to ${portName} failed`, { description: message });
        return;
      }
      setFramesByChannel((prev) => ({
        ...prev,
        [id]: [...(prev[id] ?? []), { dir: "out", data, ts: Date.now() }],
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

  const selectedScript = DEMO_SCRIPTS.find((s) => s.id === selectedScriptId) ?? null;

  const handleClear = useCallback(() => {
    if (active === null) return;
    const id = active.id;
    setFramesByChannel((prev) => ({ ...prev, [id]: [] }));
  }, [active]);

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
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <TabStrip
              tabs={tabs}
              channels={channels}
              activeId={activeId}
              onSelect={selectChannel}
              onClose={(id) => setPendingCloseId(id)}
            />
            <div className="flex min-h-0 flex-1">
              <main className="flex min-w-0 flex-1 flex-col">
                <div className="min-h-0 flex-1">
                  <FramePanel
                    channelName={active?.name ?? null}
                    frames={active !== null ? (framesByChannel[active.id] ?? []) : []}
                    onSend={handleSend}
                    onClear={handleClear}
                    canSend={active !== null && active.kind === "serial"}
                  />
                </div>
                <div className="flex h-64 shrink-0 border-t border-border">
                  <div className="w-56 shrink-0 overflow-auto border-r border-border">
                    <ScriptLibrary
                      workspaceScripts={DEMO_SCRIPTS}
                      selectedId={selectedScriptId}
                      onSelect={(s) => {
                        setSelectedScriptId(s.id);
                        setErrorLine(null);
                      }}
                      onRun={handleRun}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <ScriptEditor
                      value={scriptSource}
                      onChange={setScriptSource}
                      errorLine={errorLine}
                    />
                  </div>
                  <div className="w-80 shrink-0 overflow-auto border-l border-border">
                    <ScriptOutput rows={outputRows} onErrorLine={setErrorLine} />
                  </div>
                </div>
                {selectedScript !== null && (
                  <span className="sr-only">Editing {selectedScript.name}</span>
                )}
              </main>
              <div className="w-80 shrink-0 border-l border-border">
                <Suspense fallback={PANEL_FALLBACK}>
                  <InspectorPanel />
                </Suspense>
              </div>
            </div>
          </div>
        </div>
        <StatusBar channel={active} clock={clock} onResetCounters={resetCounters} />
        <Toaster position="bottom-right" theme="system" />
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
