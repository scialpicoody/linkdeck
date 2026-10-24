// Shared channel contract for the workbench shell.

import { useCallback, useEffect, useState } from "react";
import {
  type ChannelInfo,
  type Parity,
  type PortInfo,
  SerialService,
  type Spec,
  type StopBits,
  TcpService,
  type TransportStatus,
} from "../mygo";
import { isHostAvailable } from "./host";

/** Lifecycle state of a channel. Drives state dots in sidebar/status. */
export type ChannelState =
  | "connected"
  | "connecting"
  | "listening"
  | "reconnecting"
  | "disconnected"
  | "closed"
  | "error";

/** Every channel kind shares the same monitor, composer, and inspector. */
export type ChannelKind = "serial" | "tcp-client" | "tcp-server" | "tcp-accepted";

/** Serial parameters retained after open so edit/reopen can be transactional. */
export interface SerialChannelConfig {
  transport: "serial";
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: Parity;
  stopBits: StopBits;
  readTimeoutMs: number;
  framing: Spec;
}

interface TcpClientChannelConfig {
  transport: "tcp-client";
  address: string;
  connectTimeoutMs: number;
  reconnectEnabled: boolean;
  reconnectInitialMs: number;
  reconnectMaxMs: number;
  reconnectMaxAttempts: number;
  heartbeatMs: number;
  heartbeatPayload: string;
  framing: Spec;
}

interface TcpServerChannelConfig {
  transport: "tcp-server";
  address: string;
  framing: Spec;
}

interface TcpAcceptedChannelConfig {
  transport: "tcp-accepted";
  parentKey: string;
  framing: Spec;
}

export type ChannelConfig =
  | SerialChannelConfig
  | TcpClientChannelConfig
  | TcpServerChannelConfig
  | TcpAcceptedChannelConfig;

/** Input used when a transport has opened successfully. */
export interface NewChannel {
  id: string;
  name: string;
  endpoint: string;
  kind: ChannelKind;
  state: ChannelState;
  /** Exact backend key: serial port, TCP client/server name, or conn id. */
  backendKey: string;
  config: ChannelConfig;
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
  /** Stable host-side key used by frame and status events. */
  backendKey: string;
  /** Last successful transport configuration retained for reconnect/edit. */
  config: ChannelConfig;
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
  addChannel: (channel: NewChannel, activate?: boolean) => void;
  updateChannel: (
    id: string,
    patch: Partial<
      Pick<Channel, "name" | "kind" | "endpoint" | "backendKey" | "state" | "config" | "error">
    >,
  ) => void;
  removeChannel: (id: string) => void;
  applyTransportStatus: (statuses: TransportStatus[]) => void;
}

let channelSequence = 0;

/** Allocate an in-session stable id without relying on endpoint uniqueness. */
export function createChannelId(kind: ChannelKind): string {
  channelSequence += 1;
  return `${kind}-${channelSequence}`;
}

export function channelStateFromStatus(kind: string, state: string): ChannelState {
  if (kind === "tcp-server") return state === "listening" ? "listening" : "disconnected";
  switch (state) {
    case "connected":
      return "connected";
    case "connecting":
      return "connecting";
    case "listening":
      return "listening";
    case "reconnecting":
      return "reconnecting";
    case "closed":
      return "closed";
    case "error":
      return "error";
    default:
      return "disconnected";
  }
}

function transportStatusFromTcp(row: ChannelInfo): TransportStatus {
  return {
    key: row.name,
    kind: row.kind,
    parent: row.parent ?? "",
    endpoint: row.address,
    state: row.state ?? (row.kind === "tcp-server" ? "listening" : "disconnected"),
    error: row.error ?? "",
    attempts: row.attempts ?? 0,
  };
}

/**
 * Reconcile backend snapshots into the shared Channel model. Accepted TCP
 * connections become channels under their listening server; terminal
 * channels keep their identity and history instead of disappearing.
 */
export function reconcileChannels(
  previous: Channel[],
  statuses: TransportStatus[],
  complete = true,
): Channel[] {
  const byKey = new Map(statuses.map((status) => [status.key, status]));
  const next = previous.map((channel) => {
    const status = byKey.get(channel.backendKey);
    if (status === undefined) {
      return complete && channel.state !== "disconnected"
        ? { ...channel, state: "disconnected" as const }
        : channel;
    }
    return {
      ...channel,
      state: channelStateFromStatus(status.kind, status.state),
      error: status.error === "" ? undefined : status.error,
    };
  });

  const known = new Set(next.map((channel) => channel.backendKey));
  for (const status of statuses) {
    if (status.kind !== "tcp-conn" || known.has(status.key)) continue;
    const parent = next.find(
      (channel) => channel.kind === "tcp-server" && channel.backendKey === status.parent,
    );
    if (parent === undefined) continue;
    const fragment = status.key.split("/").at(-1) ?? status.key;
    next.push({
      id: `tcp-accepted:${status.key}`,
      name: `accepted ${fragment}`,
      endpoint: status.endpoint,
      backendKey: status.key,
      kind: "tcp-accepted",
      state: channelStateFromStatus(status.kind, status.state),
      config: {
        transport: "tcp-accepted",
        parentKey: parent.backendKey,
        framing: parent.config.framing,
      },
    });
    known.add(status.key);
  }
  return next;
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
        const [discovered, tcpRows] = await Promise.all([
          SerialService.list(),
          TcpService.list().catch(() => [] as ChannelInfo[]),
        ]);
        if (cancelled) return;
        setPorts(discovered);
        setListError(null);
        setChannels((previous) => {
          const statuses = tcpRows.map(transportStatusFromTcp);
          for (const channel of previous) {
            if (channel.kind !== "serial") continue;
            statuses.push({
              key: channel.backendKey,
              kind: "serial",
              parent: "",
              endpoint: channel.endpoint,
              state: discovered.some((port) => port.name === channel.endpoint)
                ? "connected"
                : "disconnected",
              error: "",
              attempts: 0,
            });
          }
          return reconcileChannels(previous, statuses, true);
        });
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

  const addChannel = useCallback((channel: NewChannel, activate = true) => {
    setChannels((prev) => [
      ...prev.filter((existing) => existing.id !== channel.id),
      { ...channel },
    ]);
    if (activate) setActiveId(channel.id);
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

  const applyTransportStatus = useCallback((statuses: TransportStatus[]) => {
    setChannels((previous) => reconcileChannels(previous, statuses, true));
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
    addChannel,
    updateChannel,
    removeChannel,
    applyTransportStatus,
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
    case "reconnecting":
      return "#f59e0b";
    case "listening":
      return "#3b82f6";
    case "error":
      return "#ef4444";
    case "closed":
      return "#6b7280";
    default:
      return "#9aa0a6";
  }
}
