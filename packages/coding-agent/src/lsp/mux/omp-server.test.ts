import { describe, expect, it } from "bun:test";
import { ompServerForExtension } from "./omp-server";

describe("omp server lookup", () => {
	it("returns null for an extension OMP does not serve", () => {
		expect(ompServerForExtension("/tmp", ".not-a-language")).toBeNull();
	});
});
