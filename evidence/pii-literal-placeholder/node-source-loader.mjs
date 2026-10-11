import { registerHooks } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (process.env.OMP_PII_BASELINE_SOURCE && specifier === "../examples/extensions/pii-redact") {
			return { url: pathToFileURL(path.resolve(process.env.OMP_PII_BASELINE_SOURCE)).href, shortCircuit: true };
		}
		if (specifier === "bun:test") return nextResolve("node:test", context);
		if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});
