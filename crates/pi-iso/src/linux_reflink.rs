//! Linux FICLONE-based copy-on-write tree materialisation.
//!
//! This backend recursively builds a writable directory tree at `merged` from
//! `lower`. Directories and symlinks are recreated, while regular files are
//! cloned with the Linux `FICLONE` ioctl so filesystems such as btrfs, XFS,
//! OCFS2, and bcachefs can share extents until either side is modified. There
//! is no mount or kernel state to undo, so [`stop`](IsolationBackend::stop) is
//! a recursive remove.

use std::path::Path;

use async_trait::async_trait;

#[cfg(not(target_os = "linux"))]
use crate::IsoError;
use crate::{BackendKind, IsoResult, IsolationBackend, ProbeResult};

pub struct LinuxReflinkBackend;

pub fn backend() -> &'static dyn IsolationBackend {
	&LinuxReflinkBackend
}

#[async_trait]
impl IsolationBackend for LinuxReflinkBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::LinuxReflink
	}

	fn probe(&self) -> ProbeResult {
		#[cfg(target_os = "linux")]
		{
			ProbeResult::available()
		}
		#[cfg(not(target_os = "linux"))]
		{
			ProbeResult::unavailable("Linux FICLONE reflink isolation is only available on Linux")
		}
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "linux")]
		{
			imp::start(lower, merged)
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (lower, merged);
			Err(IsoError::unavailable("Linux FICLONE reflink isolation is only available on Linux"))
		}
	}

	fn clone_tree(&self, lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
		#[cfg(target_os = "linux")]
		{
			imp::clone_tree(lower, merged, skip)
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (lower, merged, skip);
			Err(IsoError::unavailable("Linux FICLONE reflink isolation is only available on Linux"))
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "linux")]
		{
			imp::stop(merged)
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = merged;
			Ok(())
		}
	}
}

#[cfg(target_os = "linux")]
mod imp {
	use std::{
		ffi::CString,
		fs::{self, File, OpenOptions},
		os::{
			fd::AsRawFd,
			unix::{
				ffi::OsStrExt,
				fs::{MetadataExt, PermissionsExt},
			},
		},
		path::{Path, PathBuf},
	};

	use crate::{IsoError, IsoResult};

	// `libc::Ioctl` is `c_int` on musl and `c_ulong` on glibc; the constant fits
	// both.
	const FICLONE: libc::Ioctl = 0x4004_9409;

	pub fn start(lower: &Path, merged: &Path) -> IsoResult<()> {
		let lower = canonical_existing_dir(lower)?;
		prepare_destination(merged)?;

		let result = recursive_reflink(&lower, merged, None);
		if result.is_err() {
			let _ = fs::remove_dir_all(merged);
		}
		result
	}

	pub fn clone_tree(lower: &Path, merged: &Path, skip: &[&std::ffi::OsStr]) -> IsoResult<()> {
		let lower = canonical_existing_dir(lower)?;
		prepare_destination(merged)?;
		let result = recursive_reflink(&lower, merged, Some(skip));
		if result.is_err() {
			let _ = fs::remove_dir_all(merged);
		}
		result
	}

	pub fn stop(merged: &Path) -> IsoResult<()> {
		match fs::remove_dir_all(merged) {
			Ok(()) => Ok(()),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
			Err(err) => Err(IsoError::other(format!(
				"unable to remove reflink tree {}: {err}",
				merged.display()
			))),
		}
	}

	fn canonical_existing_dir(path: &Path) -> IsoResult<PathBuf> {
		let resolved = if path.is_absolute() {
			path.to_path_buf()
		} else {
			std::env::current_dir().map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
		};
		let meta = fs::metadata(&resolved).map_err(|err| {
			IsoError::other(format!("invalid reflink source {}: {err}", resolved.display()))
		})?;
		if !meta.is_dir() {
			return Err(IsoError::other(format!(
				"reflink source {} is not a directory",
				resolved.display()
			)));
		}
		Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
	}

	fn prepare_destination(merged: &Path) -> IsoResult<()> {
		if let Some(parent) = merged.parent() {
			fs::create_dir_all(parent).map_err(|err| {
				IsoError::other(format!("create parent of {}: {err}", merged.display()))
			})?;
		}
		match fs::symlink_metadata(merged) {
			Ok(meta) if meta.is_dir() => fs::remove_dir_all(merged).map_err(|err| {
				IsoError::other(format!(
					"unable to clear {} before reflink clone: {err}",
					merged.display()
				))
			})?,
			Ok(_) => fs::remove_file(merged).map_err(|err| {
				IsoError::other(format!(
					"unable to clear {} before reflink clone: {err}",
					merged.display()
				))
			})?,
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => {},
			Err(err) => {
				return Err(IsoError::other(format!(
					"unable to inspect {} before reflink clone: {err}",
					merged.display()
				)));
			},
		}
		Ok(())
	}

	fn recursive_reflink(
		src: &Path,
		dst: &Path,
		skip: Option<&[&std::ffi::OsStr]>,
	) -> IsoResult<()> {
		let meta = fs::symlink_metadata(src)
			.map_err(|err| IsoError::other(format!("symlink_metadata {}: {err}", src.display())))?;
		fs::create_dir(dst)
			.map_err(|err| IsoError::other(format!("create {}: {err}", dst.display())))?;

		let entries = fs::read_dir(src)
			.map_err(|err| IsoError::other(format!("read_dir {}: {err}", src.display())))?;
		for entry in entries {
			let entry = entry
				.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", src.display())))?;
			if skip.is_some_and(|names| names.contains(&entry.file_name().as_os_str())) {
				continue;
			}
			let file_type = entry.file_type().map_err(|err| {
				IsoError::other(format!("file_type {}: {err}", entry.path().display()))
			})?;
			let src_path = entry.path();
			let dst_path = dst.join(entry.file_name());
			// Sockets, fifos, and devices are process-owned ephemera that cannot be
			// reflinked; skip them rather than aborting the clone (parity with
			// `apfs::clone_tree`, which asserts a `debug.fifo` "must be skipped,
			// not fatal"). Only directories, symlinks, and regular files below.
			if !(file_type.is_file() || file_type.is_dir() || file_type.is_symlink()) {
				continue;
			}
			if file_type.is_symlink() {
				clone_symlink(&src_path, &dst_path)?;
			} else if file_type.is_dir() {
				recursive_reflink(&src_path, &dst_path, None)?;
			} else if file_type.is_file() {
				clone_file(&src_path, &dst_path)?;
			}
		}

		preserve_permissions(dst, &meta)?;
		let _ = set_times_nofollow(dst, &meta);
		Ok(())
	}

	fn clone_symlink(src: &Path, dst: &Path) -> IsoResult<()> {
		let target = fs::read_link(src)
			.map_err(|err| IsoError::other(format!("read_link {}: {err}", src.display())))?;
		std::os::unix::fs::symlink(target, dst)
			.map_err(|err| IsoError::other(format!("symlink {}: {err}", dst.display())))?;
		if let Ok(meta) = fs::symlink_metadata(src) {
			let _ = set_times_nofollow(dst, &meta);
		}
		Ok(())
	}

	fn clone_file(src: &Path, dst: &Path) -> IsoResult<()> {
		let meta = fs::symlink_metadata(src)
			.map_err(|err| IsoError::other(format!("symlink_metadata {}: {err}", src.display())))?;
		let src_file = File::open(src)
			.map_err(|err| IsoError::other(format!("open {}: {err}", src.display())))?;
		let dst_file = OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(dst)
			.map_err(|err| IsoError::other(format!("create {}: {err}", dst.display())))?;

		// SAFETY: both file descriptors are valid for the duration of the call.
		// FICLONE copies metadata into `dst_file` and does not retain either fd.
		let rc = unsafe { libc::ioctl(dst_file.as_raw_fd(), FICLONE, src_file.as_raw_fd()) };
		if rc != 0 {
			let err = std::io::Error::last_os_error();
			let _ = fs::remove_file(dst);
			return Err(map_clone_error(src, dst, err));
		}

		preserve_permissions(dst, &meta)?;
		let _ = set_times_nofollow(dst, &meta);
		Ok(())
	}

	fn map_clone_error(src: &Path, dst: &Path, err: std::io::Error) -> IsoError {
		if let Some(code) = err.raw_os_error()
			&& matches!(
				code,
				libc::EXDEV | libc::EOPNOTSUPP | libc::ENOTTY | libc::EINVAL | libc::ENOSYS
			) {
			return IsoError::unavailable(format!(
				"FICLONE unsupported for {} -> {}: {err}",
				src.display(),
				dst.display()
			));
		}
		IsoError::other(format!("FICLONE {} -> {}: {err}", src.display(), dst.display()))
	}

	fn preserve_permissions(path: &Path, meta: &fs::Metadata) -> IsoResult<()> {
		let mode = meta.permissions().mode();
		fs::set_permissions(path, fs::Permissions::from_mode(mode))
			.map_err(|err| IsoError::other(format!("set permissions on {}: {err}", path.display())))
	}

	fn set_times_nofollow(path: &Path, meta: &fs::Metadata) -> std::io::Result<()> {
		let times = [
			libc::timespec { tv_sec: meta.atime() as _, tv_nsec: meta.atime_nsec() as libc::c_long },
			libc::timespec { tv_sec: meta.mtime() as _, tv_nsec: meta.mtime_nsec() as libc::c_long },
		];
		let c_path = CString::new(path.as_os_str().as_bytes())?;
		// SAFETY: `c_path` and `times` live until the syscall returns; the
		// kernel does not retain either pointer. AT_SYMLINK_NOFOLLOW preserves
		// symlink timestamps instead of mutating the link target.
		let rc = unsafe {
			libc::utimensat(libc::AT_FDCWD, c_path.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW)
		};
		if rc == 0 {
			Ok(())
		} else {
			Err(std::io::Error::last_os_error())
		}
	}
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
	use std::{
		ffi::{CString, OsStr},
		fs,
		os::unix::{ffi::OsStrExt, fs::symlink, net::UnixListener},
		path::{Path, PathBuf},
	};

	use super::backend;

	/// Create a fifo at `path` via `mkfifo(3)`.
	fn mkfifo(path: &Path) {
		let c_path = CString::new(path.as_os_str().as_bytes()).expect("fifo path has no NUL");
		// SAFETY: `c_path` is a valid NUL-terminated path that outlives the call;
		// `mkfifo` only creates the directory entry and does not retain the pointer.
		assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0, "mkfifo failed");
	}

	/// Create a `debug.sock` unix socket at `path`. The listener is dropped
	/// immediately, but on Linux the socket directory entry persists until it
	/// is unlinked, so the cloning walker observes a socket file type.
	fn make_socket(path: &Path) {
		let listener = UnixListener::bind(path).expect("bind unix socket");
		drop(listener);
	}

	/// Builds a `lower/` tree containing symlinks, a nested directory, and
	/// process-owned special files (fifos and unix sockets) at the root and
	/// inside a nested directory, and optionally a top-level `.git/` with a
	/// regular file for the skip list. No regular files are placed outside
	/// `.git/`, so the tree can be cloned without a reflink-capable filesystem
	/// (`FICLONE` is never reached) and the special-file branch is exercised
	/// deterministically regardless of host filesystem.
	struct Fixture {
		root:   PathBuf,
		merged: PathBuf,
	}

	impl Fixture {
		fn new(label: &str, with_git: bool) -> Self {
			let nonce = format!(
				"pi-iso-reflink-{label}-{}-{}",
				std::process::id(),
				std::time::SystemTime::now()
					.duration_since(std::time::UNIX_EPOCH)
					.unwrap()
					.as_nanos()
			);
			let root = std::env::temp_dir().join(&nonce);
			fs::create_dir_all(root.join("nested")).expect("create nested dir");
			if with_git {
				fs::create_dir_all(root.join(".git")).expect("create .git");
				fs::write(root.join(".git/config"), "skip").expect("write .git/config");
			}
			symlink("file", root.join("link")).expect("create symlink link");
			symlink("child", root.join("nested/childlink")).expect("create nested symlink");
			// Special files (sockets, fifos, devices) are process-owned
			// ephemera; git cannot store them, so they are always untracked.
			// The reflink walker must skip them, not abort — parity with
			// `apfs::clone_tree_skips_top_level_entry_and_preserves_symlink`.
			mkfifo(&root.join("debug.fifo"));
			mkfifo(&root.join("nested/sub.fifo"));
			make_socket(&root.join("debug.sock"));
			make_socket(&root.join("nested/sub.sock"));
			let merged = root
				.parent()
				.expect("temp dir has a parent")
				.join(format!("merged-{nonce}"));
			Self { root, merged }
		}

		fn root(&self) -> &Path {
			&self.root
		}

		fn merged(&self) -> &Path {
			&self.merged
		}
	}

	impl Drop for Fixture {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
			let _ = fs::remove_dir_all(&self.merged);
		}
	}

	/// `clone_tree` skips process-owned special files (fifos, sockets) at the
	/// checkout root and inside nested directories, honours the top-level skip
	/// list, and preserves symlinks — without aborting. No reflink-capable
	/// filesystem is required: the tree has no regular files outside the
	/// skipped `.git/`, so `FICLONE` is never reached.
	#[test]
	fn clone_tree_skips_special_files_and_preserves_symlink() {
		let fixture = Fixture::new("clone", true);
		backend()
			.clone_tree(fixture.root(), fixture.merged(), &[OsStr::new(".git")])
			.expect("clone_tree must skip special files, not error");

		let merged = fixture.merged();
		assert!(!merged.join(".git").exists(), ".git must be skipped");
		assert!(
			fs::symlink_metadata(merged.join("debug.fifo")).is_err(),
			"top-level fifo must be skipped",
		);
		assert!(
			fs::symlink_metadata(merged.join("debug.sock")).is_err(),
			"top-level socket must be skipped",
		);
		assert!(
			fs::symlink_metadata(merged.join("nested/sub.fifo")).is_err(),
			"nested fifo must be skipped",
		);
		assert!(
			fs::symlink_metadata(merged.join("nested/sub.sock")).is_err(),
			"nested socket must be skipped",
		);
		assert_eq!(
			fs::read_link(merged.join("link")).unwrap(),
			Path::new("file"),
			"top-level symlink must be preserved",
		);
		assert!(
			fs::symlink_metadata(merged.join("link"))
				.unwrap()
				.file_type()
				.is_symlink(),
			"link must remain a symlink",
		);
		assert_eq!(
			fs::read_link(merged.join("nested/childlink")).unwrap(),
			Path::new("child"),
			"nested symlink must be preserved",
		);
		assert!(merged.join("nested").is_dir(), "nested directory must be created");
	}

	/// `start` (subagent isolation) shares `recursive_reflink` and skips
	/// process-owned special files rather than returning `IsoError::Other`
	/// (which `ensureIsolation` does not retry). The fixture has no regular
	/// files and no `.git`, so the call must succeed on every Linux filesystem
	/// regardless of reflink support.
	#[test]
	fn start_skips_special_files_and_preserves_symlink() {
		let fixture = Fixture::new("start", false);
		backend()
			.start(fixture.root(), fixture.merged())
			.expect("start must skip special files, not error");

		let merged = fixture.merged();
		assert!(
			fs::symlink_metadata(merged.join("debug.fifo")).is_err(),
			"top-level fifo must be skipped, not fatal",
		);
		assert!(
			fs::symlink_metadata(merged.join("debug.sock")).is_err(),
			"top-level socket must be skipped, not fatal",
		);
		assert!(
			fs::symlink_metadata(merged.join("nested/sub.fifo")).is_err(),
			"nested fifo must be skipped, not fatal",
		);
		assert!(
			fs::symlink_metadata(merged.join("nested/sub.sock")).is_err(),
			"nested socket must be skipped, not fatal",
		);
		assert_eq!(
			fs::read_link(merged.join("link")).unwrap(),
			Path::new("file"),
			"top-level symlink must be preserved",
		);
		assert_eq!(
			fs::read_link(merged.join("nested/childlink")).unwrap(),
			Path::new("child"),
			"nested symlink must be preserved",
		);
		assert!(merged.join("nested").is_dir(), "nested directory must be created");
	}

	/// Regression guard: a regular file is still cloned (or surfaces
	/// `IsoError::Unavailable` on a reflink-incapable filesystem so
	/// `ensureIsolation` can fall back) — it is never silently skipped and
	/// never surfaces as `IsoError::Other`.
	#[test]
	fn regular_file_clone_is_not_affected_by_special_file_skip() {
		let nonce = format!(
			"pi-iso-reflink-reg-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		);
		let root = std::env::temp_dir().join(&nonce);
		let merged = root
			.parent()
			.expect("temp dir has a parent")
			.join(format!("merged-{nonce}"));
		fs::create_dir_all(&root).expect("create root");
		fs::write(root.join("file"), "data").expect("write regular file");
		struct Guard(PathBuf, PathBuf);
		impl Drop for Guard {
			fn drop(&mut self) {
				let _ = fs::remove_dir_all(&self.0);
				let _ = fs::remove_dir_all(&self.1);
			}
		}
		let guard = Guard(root.clone(), merged.clone());

		let result = backend().start(&root, &merged);
		match result {
			Ok(()) => {
				assert_eq!(
					fs::read_to_string(merged.join("file")).unwrap(),
					"data",
					"reflink-capable fs must clone the regular file",
				);
			},
			Err(crate::IsoError::Unavailable(_)) => {
				// Reflink-incapable filesystem (e.g. ext4/tmpfs): `FICLONE`
				// returns `EOPNOTSUPP` and `map_clone_error` surfaces
				// `Unavailable` so `ensureIsolation` can fall back.
			},
			Err(crate::IsoError::Other(msg)) => {
				panic!("regular-file clone must surface Unavailable, not Other: {msg}");
			},
		}
		drop(guard);
	}
}
