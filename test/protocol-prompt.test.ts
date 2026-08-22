import { describe, expect, test } from "bun:test";
import {
	buildCanonicalProtocolContract,
	buildProtocolRepairPrompt,
} from "../src/protocol/prompt.ts";
import { GW_JSON_END, GW_JSON_START } from "../src/protocol/types.ts";

describe("protocol serialization prompts", () => {
	test("canonical contract explicitly forbids output outside one envelope", () => {
		const prompt = buildCanonicalProtocolContract({ lang: "en" });
		expect(prompt).toContain("STRICT OUTPUT CONTRACT");
		expect(prompt).toContain("exactly one protocol envelope");
		expect(prompt).toContain("Do not emit more than one top-level JSON object");
		expect(prompt).toContain(`MUST be ${GW_JSON_START}`);
		expect(prompt).toContain(`MUST be ${GW_JSON_END}`);
	});

	test("repair prompt asks only for re-serialization of the same intent", () => {
		const previous = '{"type":"tool_call","calls":[]}';
		const prompt = buildProtocolRepairPrompt(previous, "missing_envelope", "en");
		expect(prompt).toContain("serialization-only repair");
		expect(prompt).toContain("SAME intended response");
		expect(prompt).toContain("preserve the same action name(s) and arguments");
		expect(prompt).toContain(`exactly one ${GW_JSON_START} ... ${GW_JSON_END} envelope`);
		expect(prompt).toContain(previous);
	});
});
