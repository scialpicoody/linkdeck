import { Suspense, lazy, useEffect, useState } from "react";
import { useChannels } from "./lib/channels";
import { Sidebar } from "./components/layout/Sidebar";
import { TabStrip } from "./components/layout/TabStrip";
import { StatusBar } from "./components/layout/StatusBar";
import { events } from "./mygo";

// Lazy placeholder slots for sibling panels. Wave-2 slices replace the
// modules below with real implementations, keeping the
// `<TerminalPanel channel />` / `<InspectorPanel channel />` props contract.
const TerminalPanel = lazy(() => import("./components/panels/TerminalPanel"));
const InspectorPanel = lazy(() => import("./components/panels/InspectorPanel"));

const PANEL_FALLBACK = (
  <div className="grid flex-1 place-items-center text-sm text-muted-foreground">Loading…</div>
);

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

  useEffect(
    () =>
      events.tick.on((time) => {
        setClock(new Date(time).toLocaleTimeString());
      }),
    [],
  );

  // Clear the unread badge whenever the active channel changes.
  useEffect(() => {
    if (activeId !== null) markRead(activeId);
  }, [activeId, markRead]);

  return (
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
            onClose={closeChannel}
          />
          <div className="flex min-h-0 flex-1">
            <main className="flex min-w-0 flex-1 flex-col">
              <Suspense fallback={PANEL_FALLBACK}>
                <TerminalPanel channel={active} />
              </Suspense>
            </main>
            <Suspense fallback={PANEL_FALLBACK}>
              <InspectorPanel channel={active} />
            </Suspense>
          </div>
        </div>
      </div>
      <StatusBar channel={active} clock={clock} onResetCounters={resetCounters} />
    </div>
  );
}
