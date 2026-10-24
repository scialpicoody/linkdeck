import { describe, expect, it } from "vitest";
import {
  type Channel,
  type ChannelState,
  channelStateFromStatus,
  channelWithTraffic,
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
    unread: 0,
    rxBytes: 0,
    txBytes: 0,
  };

  it("maps every transport state into the shared channel model", () => {
    expect(channelStateFromStatus("tcp-client", "reconnecting")).toBe("reconnecting");
    expect(channelStateFromStatus("tcp-client", "closed")).toBe("closed");
    expect(channelStateFromStatus("tcp-server", "listening")).toBe("listening");
    expect(channelStateFromStatus("tcp-conn", "connected")).toBe("connected");
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

  it("preserves identity, history, and counters across removal and recovery", () => {
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
      rxBytes: 42,
      txBytes: 7,
    };
    const removed = reconcileChannels([serial], []);
    expect(removed[0]).toMatchObject({
      id: "serial-1",
      state: "disconnected",
      rxBytes: 42,
      txBytes: 7,
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
    expect(recovered[0]).toMatchObject({ state: "connected", rxBytes: 42, txBytes: 7 });
  });

  it("counts unread frames even when a complete frame has zero payload bytes", () => {
    const inbound = channelWithTraffic(
      { ...server, kind: "serial", config: { ...server.config, transport: "serial" } } as Channel,
      "in",
      0,
      null,
    );
    expect(inbound.unread).toBe(1);
    expect(channelWithTraffic(inbound, "out", 3, null).unread).toBe(1);
  });
});
