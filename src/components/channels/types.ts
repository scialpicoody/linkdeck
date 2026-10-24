import type { Parity, StopBits } from "../../mygo";
import type { FramingKind } from "../inspector/types";

/**
 * Channel form value for the open/edit dialog (#18).
 *
 * Mirrors OpenRequest for the transport fields plus the framing selection
 * (stored into presets / applied when the backend framing path lands).
 */
export interface ChannelFormValue {
  port: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: Parity;
  stopBits: StopBits;
  framing: FramingKind;
  framingOption: string;
  readTimeoutMs: number;
}
