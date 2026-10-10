# Locally frozen baseline evidence

The oracle bytes and allocation budget were captured locally before the generic AWS candidate edits. This recording commit is assembled after the experiment; it does not claim that an earlier Git freeze commit existed.

Baseline: `46ad32961a96aef21cd35fe615374f4b3675ca58`.

- Twelve synthetic exact-output cases: `frozen-output.json`, SHA256 `51ef0ba4b6b59738406f1d3ad8aee98ab6d23102f07f5aca25a14738313793dd`.
- Original timed harness: `timed-harness.rs`, SHA256 `b07ce047e1ccbd92023ee06a0b77405f56cc767ead5a50c66dd040c7d036d29b`.
- Regression budget: fewer than 262,144 cumulative requested allocation bytes for 1,000 rows with 1,025,024 TOTAL unrendered payload bytes. Fixture parsing/construction is outside the allocation region.
- Actual baseline: 4,861,047 cumulative requested allocation bytes, 35,191 requests, 548 output bytes. `red.log` records the budget assertion failure (child exit 101).

The following implementation commit adds a reproducible runner, candidate checks, bounded timing evidence, and full validation outcomes. The timing profile and measurement limits are documented there.
