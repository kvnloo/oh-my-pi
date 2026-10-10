// Independent validation of roboomp's PR #11111, reported by szavadsky in #11109.
import { IncomingDoc } from "../../packages/utils/src/incoming-json";
import { JsonLexer } from "../../packages/utils/src/json-lexer";

const count = Number(Bun.argv[2] ?? 20_000);
const instrument = Bun.argv[3] === "scalar";
const injectFailure = Bun.argv[4] === "failure";
const originalPeek = JsonLexer.prototype.peek;
let reads = 0;
let sum = 0;
let exhausted = false;
let failureObserved = false;
if (instrument) {
	JsonLexer.prototype.peek = function (this: JsonLexer): number {
		reads++;
		return originalPeek.call(this);
	};
}
const started = performance.now();
try {
	const { feed, doc } = IncomingDoc.channel();
	const items = doc.root().object().key("items").array();
	feed.push('{"items":[');
	for (let i = 0; i < count; i++) {
		feed.push(`{"n":${i}},`);
		const element = await items.next();
		sum += await element!.object().key("n").number();
		if (injectFailure && i === 3) throw new Error("injected validation failure");
	}
	feed.push("]}");
	feed.finish();
	exhausted = (await items.next()) === undefined;
} catch (error) {
	if (!injectFailure || !(error instanceof Error) || error.message !== "injected validation failure") throw error;
	failureObserved = true;
} finally {
	JsonLexer.prototype.peek = originalPeek;
}
const elapsedMs = performance.now() - started;
const restored = JsonLexer.prototype.peek === originalPeek;
const sumCorrect = sum === (count * (count - 1)) / 2;
const readBound = !instrument || reads < count * 250;
const semantics = injectFailure ? failureObserved : sumCorrect && exhausted;
console.log(
	JSON.stringify({
		count,
		instrument,
		injectFailure,
		elapsedMs,
		reads: instrument ? reads : null,
		readsPerElement: instrument ? reads / count : null,
		sum,
		sumCorrect,
		exhausted,
		readBound,
		restored,
		failureObserved,
	}),
);
if (!semantics || !restored || (!injectFailure && !readBound)) process.exitCode = 1;
