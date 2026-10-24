import { describe, expect, it } from "vitest";
import {
  SequencePanel,
  type SequencePanelProps,
  SequencePanelView,
  type SequencePanelViewProps,
} from "./index";

describe("SequencePanel module", () => {
  it("exports the host-wired panel and its injectable view", () => {
    expect(typeof SequencePanel).toBe("function");
    expect(typeof SequencePanelView).toBe("function");
  });

  it("keeps Channel and TX capture in the public props contract", () => {
    type Props = SequencePanelProps & Pick<SequencePanelViewProps, "controller">;
    const keys: Array<keyof Props> = ["channel", "onIoCapture", "controller"];
    expect(keys).toEqual(["channel", "onIoCapture", "controller"]);
  });
});
