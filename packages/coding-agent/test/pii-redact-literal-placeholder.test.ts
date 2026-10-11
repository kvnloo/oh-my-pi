import { it } from "bun:test";
import assert from "node:assert/strict";
import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import piiRedactExtension from "../examples/extensions/pii-redact";

const INPUT = "mail synthetic@example.com phone 555-123-4567 ssn 123-45-6789";

// "$&amp;amp;" is a separate additional literal fixture, not an encoded "$&amp;".
for (const placeholder of ["$&amp;", "$&amp;amp;", "$&", "$$", "$`", "$'", "[PII]"]) {
	it(`inserts ${JSON.stringify(placeholder)} literally for email, phone and SSN in the registered handler`, async () => {
		let handler: ExtensionHandler<BeforeProviderRequestEvent, unknown> | undefined;
		const previous = {
			cmd: process.env.PAW_PII_CMD,
			disable: process.env.PAW_PII_DISABLE,
			placeholder: process.env.PAW_PII_PLACEHOLDER,
		};
		try {
			delete process.env.PAW_PII_CMD;
			delete process.env.PAW_PII_DISABLE;
			process.env.PAW_PII_PLACEHOLDER = placeholder;
			piiRedactExtension({
				setLabel: () => {},
				registerCommand: () => {},
				on: (event: string, callback: ExtensionHandler<BeforeProviderRequestEvent, unknown>) => {
					if (event === "before_provider_request") handler = callback;
				},
			} as unknown as ExtensionAPI);
			assert.ok(handler);
			const result = await handler({ type: "before_provider_request", payload: INPUT }, {} as ExtensionContext);
			assert.equal(result, `mail ${placeholder} phone ${placeholder} ssn ${placeholder}`);
		} finally {
			if (previous.cmd === undefined) delete process.env.PAW_PII_CMD;
			else process.env.PAW_PII_CMD = previous.cmd;
			if (previous.disable === undefined) delete process.env.PAW_PII_DISABLE;
			else process.env.PAW_PII_DISABLE = previous.disable;
			if (previous.placeholder === undefined) delete process.env.PAW_PII_PLACEHOLDER;
			else process.env.PAW_PII_PLACEHOLDER = previous.placeholder;
		}
	});
}
