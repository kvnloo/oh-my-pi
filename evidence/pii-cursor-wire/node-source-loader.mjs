import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../../", import.meta.url);

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (process.env.OMP_PII_BASELINE_SOURCE && specifier === "../examples/extensions/pii-redact") {
			return { url: pathToFileURL(resolve(process.env.OMP_PII_BASELINE_SOURCE)).href, shortCircuit: true };
		}
		if (specifier === "bun:test") return nextResolve("node:test", context);
		if (specifier === "@oh-my-pi/pi-utils") {
			return { url: new URL("packages/utils/src/type-guards.ts", root).href, shortCircuit: true };
		}
		if (specifier.startsWith("@oh-my-pi/pi-catalog/")) {
			const module = specifier.slice("@oh-my-pi/pi-catalog/".length);
			return { url: new URL(`packages/catalog/src/${module}.ts`, root).href, shortCircuit: true };
		}
		if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});
