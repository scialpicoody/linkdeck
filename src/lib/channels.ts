// Shared channel contract for the workbench shell.

import { useCallback, useEffect, useState } from "react";
import { type PortInfo, SerialService } from "../mygo";
import { isHostAvailable } from "./host";

/** Lifecycle state of a channel. Drives state dots in sidebar/status. */
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
  /** Unread inbound-frame count shown in the channel rail. */
  unread: number;
  /** Cumulative counters; reset via resetCounters. */
  rxBytes: number;
  txBytes: number;
  /** Last error message, if state is "error". */
  error?: string;
  /** Raw port detail when sourced from SerialService.list(). */
  port?: PortInfo;
}

export interface UseChannels {
  /** All known channels (from SerialService.list polling). */
  channels: Channel[];
  /** Active channel id, or null when none is selected. */
  activeId: string | null;
  /** Active channel object, or null. */
  active: Channel | null;
  portsLoading: boolean;
  listError: string | null;
  openChannel: (id: string) => void;
  selectChannel: (id: string) => void;
  markRead: (id: string) => void;
  resetCounters: (id: string) => void;
  /** Record decoded frame bytes and update state/unread counters. */
  addTraffic: (id: string, dir: "in" | "out", bytes: number) => void;
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
 * useChannels polls SerialService.list() for the channel rail and owns
 * selection plus per-channel RX/TX, unread, and lifecycle state.
 */
export function useChannels(pollMs = 3000): UseChannels {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [portsLoading, setPortsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    // Browser-only mode has no SerialService; skip polling and report no
    // channels instead of surfacing a transport error as a failure.
    if (!isHostAvailable()) {
      setPortsLoading(false);
      return;
    }
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

  useEffect(() => {
    if (activeId !== null && !channels.some((channel) => channel.id === activeId)) {
      setActiveId(null);
    }
  }, [channels, activeId]);

  const openChannel = useCallback((id: string) => {
    setActiveId(id);
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

  const addTraffic = useCallback(
    (id: string, dir: "in" | "out", bytes: number) => {
      if (bytes <= 0) return;
      setChannels((prev) =>
        prev.map((channel) => {
          if (channel.id !== id) return channel;
          return {
            ...channel,
            state: channel.state === "error" ? channel.state : "connected",
            error: dir === "in" ? undefined : channel.error,
            rxBytes: channel.rxBytes + (dir === "in" ? bytes : 0),
            txBytes: channel.txBytes + (dir === "out" ? bytes : 0),
            unread: dir === "in" && id !== activeId ? channel.unread + 1 : channel.unread,
          };
        }),
      );
    },
    [activeId],
  );

  const setChannelState = useCallback((id: string, state: ChannelState, error?: string) => {
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, state, error } : c)));
  }, []);

  const active = channels.find((c) => c.id === activeId) ?? null;

  return {
    channels,
    activeId,
    active,
    portsLoading,
    listError,
    openChannel,
    selectChannel,
    markRead,
    resetCounters,
    addTraffic,
    setChannelState,
  };
}

/**
 * stateColor maps a ChannelState to its state-dot fill. Shared by the
 * sidebar and status bar so dots stay consistent.
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
