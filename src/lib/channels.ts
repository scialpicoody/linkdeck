// Shared channel contract for the workbench shell.

import { useCallback, useEffect, useState } from "react";
import { type Parity, type PortInfo, SerialService, type Spec, type StopBits } from "../mygo";
import { isHostAvailable } from "./host";

/** Lifecycle state of a channel. Drives state dots in sidebar/status. */
export type ChannelState = "connected" | "connecting" | "disconnected" | "error";

/** Transport kind. TCP variants join this union in the TCP integration slice. */
export type ChannelKind = "serial";

/** Serial parameters retained after open so edit/reopen can be transactional. */
export interface SerialChannelConfig {
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: Parity;
  stopBits: StopBits;
  readTimeoutMs: number;
  framing: Spec;
}

/** Input used when a transport has opened successfully. */
interface NewChannel {
  id: string;
  name: string;
  endpoint: string;
  kind: ChannelKind;
  state: ChannelState;
  config: SerialChannelConfig;
}

/**
 * Channel is one open communication endpoint. It is deliberately separate
 * from a discovered serial port: unplugging a port marks the channel
 * disconnected but never destroys its frame history.
 */
export interface Channel {
  /** Stable frontend id; endpoint edits do not change it. */
  id: string;
  /** Display name. */
  name: string;
  kind: ChannelKind;
  state: ChannelState;
  /** Backend channel key and human-readable endpoint. */
  endpoint: string;
  /** Serial parameters used for the current (or last successful) open. */
  config: SerialChannelConfig;
  /** Unread inbound-frame count shown in the channel rail. */
  unread: number;
  /** Cumulative counters; reset via resetCounters. */
  rxBytes: number;
  txBytes: number;
  /** Last transport-level error, if state is "error". */
  error?: string;
}

export interface UseChannels {
  /** Discovered serial devices, not open channels. */
  ports: PortInfo[];
  /** Open channels owned by this workbench session. */
  channels: Channel[];
  activeId: string | null;
  active: Channel | null;
  portsLoading: boolean;
  listError: string | null;
  selectChannel: (id: string) => void;
  markRead: (id: string) => void;
  resetCounters: (id: string) => void;
  addChannel: (channel: NewChannel) => void;
  updateChannel: (
    id: string,
    patch: Partial<Pick<Channel, "name" | "endpoint" | "state" | "config" | "error">>,
  ) => void;
  removeChannel: (id: string) => void;
  /** Record decoded frame bytes and update state/unread counters. */
  addTraffic: (id: string, dir: "in" | "out", bytes: number) => void;
  setChannelState: (id: string, state: ChannelState, error?: string) => void;
}

let channelSequence = 0;

/** Allocate an in-session stable id without relying on endpoint uniqueness. */
export function createChannelId(kind: ChannelKind): string {
  channelSequence += 1;
  return `${kind}-${channelSequence}`;
}

/**
 * useChannels polls discovered serial ports and separately owns open
 * channels. Polling can mark a channel disconnected, but never replaces the
 * channel list, so manual endpoints and history survive discovery changes.
 */
export function useChannels(pollMs = 3000): UseChannels {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [portsLoading, setPortsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    if (!isHostAvailable()) {
      setPortsLoading(false);
      return;
    }
    let cancelled = false;
    async function poll() {
      try {
        const discovered = await SerialService.list();
        if (cancelled) return;
        setPorts(discovered);
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

  const selectChannel = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const markRead = useCallback((id: string) => {
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
  }, []);

  const resetCounters = useCallback((id: string) => {
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, rxBytes: 0, txBytes: 0 } : c)));
  }, []);

  const addChannel = useCallback((channel: NewChannel) => {
    setChannels((prev) => [
      ...prev.filter((existing) => existing.id !== channel.id),
      { ...channel, unread: 0, rxBytes: 0, txBytes: 0 },
    ]);
    setActiveId(channel.id);
  }, []);

  const updateChannel = useCallback<UseChannels["updateChannel"]>((id, patch) => {
    setChannels((prev) =>
      prev.map((channel) => (channel.id === id ? { ...channel, ...patch } : channel)),
    );
  }, []);

  const removeChannel = useCallback((id: string) => {
    setChannels((prev) => prev.filter((channel) => channel.id !== id));
    setActiveId((current) => (current === id ? null : current));
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
