import { describe, expect, it } from "vitest";
import {
  type Channel,
  type ChannelState,
  canReconnect,
  channelStateFromStatus,
  reconcileChannels,
  stateColor,
} from "./channels";

const STATES: ChannelState[] = [
  "connected",
  "connecting",
  "listening",
  "reconnecting",
  "disconnected",
  "closed",
  "error",
];

describe("stateColor", () => {
  it("returns a hex fill for every channel state", () => {
    for (const state of STATES) {
      expect(stateColor(state)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps every state visually distinct", () => {
    const fills = new Set(STATES.map(stateColor));
    expect(fills.size).toBe(STATES.length);
  });

  it("is deterministic per state", () => {
    expect(stateColor("connected")).toBe(stateColor("connected"));
  });
});

describe("transport reconciliation", () => {
  const server: Channel = {
    id: "server",
    name: "server",
    kind: "tcp-server",
    state: "listening",
    endpoint: "127.0.0.1:9000",
    backendKey: "server",
    config: {
      transport: "tcp-server",
      address: "127.0.0.1:9000",
      framing: { kind: "delimiter", delimiterHex: "0A" },
    },
  };

  it("maps every transport state into the shared channel model", () => {
    expect(channelStateFromStatus("tcp-client", "reconnecting")).toBe("reconnecting");
    expect(channelStateFromStatus("tcp-client", "closed")).toBe("closed");
    expect(channelStateFromStatus("tcp-server", "listening")).toBe("listening");
    expect(channelStateFromStatus("tcp-conn", "connected")).toBe("connected");
  });

  it("offers manual reconnect only for inactive owned channels", () => {
    expect(canReconnect({ kind: "serial", state: "disconnected" })).toBe(true);
    expect(canReconnect({ kind: "tcp-client", state: "closed" })).toBe(true);
    expect(canReconnect({ kind: "tcp-server", state: "error" })).toBe(true);
    expect(canReconnect({ kind: "tcp-client", state: "reconnecting" })).toBe(false);
    expect(canReconnect({ kind: "tcp-accepted", state: "disconnected" })).toBe(false);
    expect(canReconnect({ kind: "serial", state: "connected" })).toBe(false);
  });

  it("adds accepted connections under their server without activating them", () => {
    const next = reconcileChannels(
      [server],
      [
        {
          key: "server",
          kind: "tcp-server",
          parent: "",
          endpoint: "127.0.0.1:9000",
          state: "listening",
          error: "",
          attempts: 0,
        },
        {
          key: "server/c1",
          kind: "tcp-conn",
          parent: "server",
          endpoint: "127.0.0.1:50123",
          state: "connected",
          error: "",
          attempts: 0,
        },
      ],
    );
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({
      id: "tcp-accepted:server/c1",
      kind: "tcp-accepted",
      state: "connected",
      endpoint: "127.0.0.1:50123",
    });
  });

  it("keeps closed channels for history while marking missing backends disconnected", () => {
    const next = reconcileChannels([server], [], true);
    expect(next[0]?.state).toBe("disconnected");
    expect(next[0]?.backendKey).toBe("server");
  });

  it("surfaces consecutive TCP reconnect attempts from host status", () => {
    const client: Channel = {
      ...server,
      id: "client-1",
      name: "bench",
      kind: "tcp-client",
      state: "connected",
      endpoint: "127.0.0.1:7000",
      backendKey: "client-1",
      config: {
        transport: "tcp-client",
        address: "127.0.0.1:7000",
        connectTimeoutMs: 5000,
        reconnectEnabled: true,
        reconnectInitialMs: 100,
        reconnectMaxMs: 5000,
        reconnectMaxAttempts: 0,
        heartbeatMs: 0,
        heartbeatPayload: "",
        framing: { kind: "delimiter", delimiterHex: "0A" },
      },
    };
    const next = reconcileChannels(
      [client],
      [
        {
          key: "client-1",
          kind: "tcp-client",
          parent: "",
          endpoint: "127.0.0.1:7000",
          state: "reconnecting",
          error: "connection refused",
          attempts: 3,
        },
      ],
    );
    expect(next[0]).toMatchObject({
      state: "reconnecting",
      attempts: 3,
      error: "connection refused",
    });
  });

  it("preserves identity and state across removal and recovery", () => {
    const serial: Channel = {
      ...server,
      id: "serial-1",
      name: "/dev/ttyUSB0",
      kind: "serial",
      state: "connected",
      endpoint: "/dev/ttyUSB0",
      backendKey: "/dev/ttyUSB0",
      config: {
        transport: "serial",
        baudRate: 115200,
        dataBits: 8,
        parity: "none",
        stopBits: "1",
        readTimeoutMs: 0,
        framing: { kind: "delimiter", delimiterHex: "0A" },
      },
    };
    const removed = reconcileChannels([serial], []);
    expect(removed[0]).toMatchObject({
      id: "serial-1",
      state: "disconnected",
    });
    const recovered = reconcileChannels(removed, [
      {
        key: "/dev/ttyUSB0",
        kind: "serial",
        parent: "",
        endpoint: "/dev/ttyUSB0",
        state: "connected",
        error: "",
        attempts: 0,
      },
    ]);
    expect(recovered[0]).toMatchObject({ id: "serial-1", state: "connected" });
  });
});
