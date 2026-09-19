import { describe, expect, it } from "bun:test";
import pkg from "../package.json";

describe("package manifest exposes an OMP extension entry", () => {
	it("declares omp.extensions pointing at ./src/extension.ts", () => {
		expect(pkg.omp).toBeDefined();
		expect(pkg.omp.extensions).toContain("./src/extension.ts");
	});
});
