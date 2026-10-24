// Shared channel/tab contract for the workbench shell (wave 1).
// Sibling slices (terminal, inspector, scripts) consume these types and the
// useChannels hook. Keep this module minimal and stable: only additive
// changes, never renames, without coordinating with all panel owners.

import { useCallback, useEffect, useState } from "react";
import { type PortInfo, SerialService } from "../mygo";

/** Lifecycle state of a channel. Drives state dots in sidebar/tabs/status. */
export type ChannelState = "connected" | "connecting" | "disconnected" | "error";

/** Transport kind. Only serial exists today; TCP variants are reserved. */
type ChannelKind = "serial";

/**
 * Channel is a named communication endpoint. Today every channel mirrors a
 * serial port reported by SerialService.list(); later slices add open/config
 * behavior without changing this shape.
 */
export interface Channel {
  /** Stable id; for serial channels this is the port name. */
  id: string;
  /** Display name (port name, e.g. "/dev/tty.usbserial-110"). */
  name: string;
  kind: ChannelKind;
  state: ChannelState;
  /** Endpoint label for the status bar (port name for serial). */
  endpoint: string;
  /** Baud rate when known; undefined until configured/opened. */
  baudRate?: number;
  /** Unread frames/bytes badge for the tab strip. */
  unread: number;
  /** Cumulative counters; reset via resetCounters. */
  rxBytes: number;
  txBytes: number;
  /** Last error message, if state is "error". */
  error?: string;
  /** Raw port detail when sourced from SerialService.list(). */
  port?: PortInfo;
}

/** An open workbench tab. One tab per open channel (no pinning). */
export interface ChannelTab {
  channelId: string;
}

export interface UseChannels {
  /** All known channels (from SerialService.list polling). */
  channels: Channel[];
  /** Open tabs in open order. */
  tabs: ChannelTab[];
  /** Active tab's channel id, or null when no tab is open. */
  activeId: string | null;
  /** Active channel object, or null. */
  active: Channel | null;
  portsLoading: boolean;
  listError: string | null;
  openChannel: (id: string) => void;
  closeChannel: (id: string) => void;
  selectChannel: (id: string) => void;
  markRead: (id: string) => void;
  resetCounters: (id: string) => void;
  /** Wave-2 hook point: real open/config lands here. Not wired yet. */
  setChannelState: (id: string, state: ChannelState, error?: string) => void;
}

function toChannel(port: PortInfo, prev?: Channel): Channel {
  return {
    id: port.name,
    name: port.name,
    kind: "serial",
    state: prev?.state ?? "disconnected",
    endpoint: port.name,
    baudRate: prev?.baudRate,
    unread: prev?.unread ?? 0,
    rxBytes: prev?.rxBytes ?? 0,
    txBytes: prev?.txBytes ?? 0,
    error: prev?.error,
    port,
  };
}

/**
 * useChannels polls SerialService.list() for the sidebar channel tree and
 * owns tab open/close/select plus per-channel RX/TX counters. Mock traffic
 * is intentionally absent: counters stay 0 until the transport slice feeds
 * them (wave 2 adds addRx/addTx here).
 */
export function useChannels(pollMs = 3000): UseChannels {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [tabs, setTabs] = useState<ChannelTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [portsLoading, setPortsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const ports = await SerialService.list();
        if (cancelled) return;
        setChannels((prev) => {
          const prevById = new Map(prev.map((c) => [c.id, c]));
          return ports.map((p) => toChannel(p, prevById.get(p.name)));
        });
        setListError(null);
      } catch (err) {
        if (cancelled) return;
        setListError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setPortsLoading(false);
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  // Drop tabs whose channel vanished (unplugged) — keep selection valid.
  useEffect(() => {
    setTabs((prev) => {
      const ids = new Set(channels.map((c) => c.id));
      const kept = prev.filter((t) => ids.has(t.channelId));
      return kept.length === prev.length ? prev : kept;
    });
  }, [channels]);

  useEffect(() => {
    if (activeId !== null && !tabs.some((t) => t.channelId === activeId)) {
      const last = tabs[tabs.length - 1];
      setActiveId(last === undefined ? null : last.channelId);
    }
  }, [tabs, activeId]);

  const openChannel = useCallback((id: string) => {
    setTabs((prev) => (prev.some((t) => t.channelId === id) ? prev : [...prev, { channelId: id }]));
    setActiveId(id);
  }, []);

  const closeChannel = useCallback((id: string) => {
    setTabs((prev) => prev.filter((t) => t.channelId !== id));
  }, []);

  const selectChannel = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const markRead = useCallback((id: string) => {
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
  }, []);

  const resetCounters = useCallback((id: string) => {
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, rxBytes: 0, txBytes: 0 } : c)));
  }, []);

  const setChannelState = useCallback((id: string, state: ChannelState, error?: string) => {
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, state, error } : c)));
  }, []);

  const active = channels.find((c) => c.id === activeId) ?? null;

  return {
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
  };
}

/**
 * stateColor maps a ChannelState to its state-dot fill. Shared by the
 * sidebar, tab strip, and status bar so dots stay consistent.
 */
export function stateColor(state: ChannelState): string {
  switch (state) {
    case "connected":
      return "#22c55e";
    case "connecting":
      return "#eab308";
    case "error":
      return "#ef4444";
    default:
      return "#9aa0a6";
  }
}
