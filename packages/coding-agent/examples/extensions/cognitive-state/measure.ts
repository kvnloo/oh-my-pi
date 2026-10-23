import type { ArmBytes, ContextMessage } from "./types.ts";
import { RLM_DONOR_SPILL_BYTES } from "./types.ts";
import { applySpillOnly, contextBytes } from "./spill.ts";

export function measureArms(
	native: readonly ContextMessage[],
	packetText: string,
	spillBytes = RLM_DONOR_SPILL_BYTES,
): ArmBytes {
	return {
		native_context_bytes: contextBytes(native),
		rlm_spill_bytes: contextBytes(applySpillOnly(native, spillBytes)),
		state_packet_bytes: Buffer.byteLength(packetText, "utf8"),
	};
}

export function growthFromPrevious(current: ArmBytes, previous?: ArmBytes): ArmBytes {
	if (!previous) {
		return { native_context_bytes: 0, rlm_spill_bytes: 0, state_packet_bytes: 0 };
	}
	return {
		native_context_bytes: current.native_context_bytes - previous.native_context_bytes,
		rlm_spill_bytes: current.rlm_spill_bytes - previous.rlm_spill_bytes,
		state_packet_bytes: current.state_packet_bytes - previous.state_packet_bytes,
	};
}
