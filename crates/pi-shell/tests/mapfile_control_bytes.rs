//! Regression tests for `mapfile`/`readarray` handling of literal `0x03`
//! (Ctrl+C) and `0x04` (Ctrl+D) bytes on non-TTY input.
//!
//! On a pipe the terminal guard returned by `setup_terminal_settings` is
//! `None` (no termios to put into raw mode), so `0x03`/`0x04` are ordinary
//! data. bash — the compatibility target — keeps them as data. brush used to
//! unconditionally treat `0x03` as a line delimiter (dropping the byte and
//! splitting the line) and a leading `0x04` as end-of-input (truncating the
//! array), corrupting binary-ish non-TTY input. These tests pin the corrected
//! behavior on the two control-byte match arms.

#![cfg(unix)]

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, execute_shell},
};

/// Runs one shell command through the public one-shot entry point and returns
/// its exit code plus captured stdout. A generous timeout keeps a regression
/// that deadlocks the read loop from hanging the test suite.
async fn run(command: &str) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = execute_shell(
		ShellExecuteOptions {
			command: command.to_string(),
			timeout_ms: Some(30_000),
			..Default::default()
		},
		Some(tx),
		CancelToken::new(None),
	)
	.await
	.expect("shell execution");
	let output = rx.try_iter().collect();
	(result.exit_code, output)
}

/// Asserts the command succeeds (exit 0) and returns its trimmed stdout.
async fn run_ok(command: &str) -> String {
	let (code, output) = run(command).await;
	assert_eq!(code, Some(0), "command failed ({code:?}): {command}\noutput: {output}");
	output.trim_end().to_string()
}

/// A literal `0x03` mid-line on a pipe must be kept as data: `printf
/// 'a\x03b\n'` yields a single array element `"a\x03b"`, not the pre-fix `["a",
/// "b"]` pair where the `0x03` byte was dropped and the line split there.
#[tokio::test]
async fn mapfile_keeps_ctrl_c_byte_on_pipe() {
	let out = run_ok(
		"printf 'a\\x03b\\n' | { mapfile -t arr; echo \"N=${#arr[@]}\"; case \"${arr[0]}\" in \
		 *$'\\003'*) echo HAS_C;; *) echo NO_C;; esac; echo \"L0=${#arr[0]}\"; }",
	)
	.await;
	assert!(out.contains("N=1"), "expected one element, got: {out}");
	assert!(out.contains("HAS_C"), "0x03 byte must be preserved, got: {out}");
	assert!(out.contains("L0=3"), "element must be 3 bytes (a,0x03,b), got: {out}");
}

/// A leading `0x04` byte at the start of a later line on a pipe must NOT
/// terminate input: `printf 'a\n\x04b\n'` yields two elements `["a", "\x04b"]`,
/// not the pre-fix truncated `["a"]` that lost every subsequent entry.
#[tokio::test]
async fn mapfile_keeps_leading_ctrl_d_byte_on_pipe() {
	let out = run_ok(
		"printf 'a\\n\\x04b\\n' | { mapfile -t arr; echo \"N=${#arr[@]}\"; case \"${arr[1]}\" in \
		 *$'\\004'*) echo HAS_D;; *) echo NO_D;; esac; echo \"L1=${#arr[1]}\"; }",
	)
	.await;
	assert!(out.contains("N=2"), "expected two elements, got: {out}");
	assert!(out.contains("HAS_D"), "0x04 byte must be preserved, got: {out}");
	assert!(out.contains("L1=2"), "second element must be 2 bytes (0x04,b), got: {out}");
}
