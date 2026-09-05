//! Vendored and extended language definitions for ast-grep integration.
//!
//! Originally derived from `ast-grep-language` v0.39.9, stripped of
//! serde/ignore machinery, and extended with additional languages.

mod parsers;

use std::{borrow::Cow, fmt, path::Path, sync::LazyLock};

use ast_grep_core::{
	Language,
	matcher::{Pattern, PatternBuilder, PatternError},
	meta_var::MetaVariable,
	tree_sitter::{LanguageExt, StrDoc, TSLanguage},
};
use phf::phf_map;

/// Implements a stub language (no expando / `pre_process_pattern` needed).
/// Use when the language grammar accepts `$VAR` as valid identifiers.
macro_rules! impl_lang {
	($lang:ident, $func:ident) => {
		#[derive(Clone, Copy, Debug)]
		pub struct $lang;
		impl Language for $lang {
			fn kind_to_id(&self, kind: &str) -> u16 {
				self.get_ts_language().id_for_node_kind(kind, true)
			}

			fn field_to_id(&self, field: &str) -> Option<u16> {
				self
					.get_ts_language()
					.field_id_for_name(field)
					.map(|f| f.get())
			}

			fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
				builder.build(|src| StrDoc::try_new(src, *self))
			}
		}
		impl LanguageExt for $lang {
			fn get_ts_language(&self) -> TSLanguage {
				parsers::$func().into()
			}
		}
	};
}

fn pre_process_pattern(expando: char, query: &str) -> Cow<'_, str> {
	let mut ret = Vec::with_capacity(query.len());
	let mut dollar_count = 0;
	for c in query.chars() {
		if c == '$' {
			dollar_count += 1;
			continue;
		}
		let need_replace = matches!(c, 'A'..='Z' | '_') || dollar_count == 3;
		let sigil = if need_replace { expando } else { '$' };
		ret.extend(std::iter::repeat_n(sigil, dollar_count));
		dollar_count = 0;
		ret.push(c);
	}
	let sigil = if dollar_count == 3 { expando } else { '$' };
	ret.extend(std::iter::repeat_n(sigil, dollar_count));
	Cow::Owned(ret.into_iter().collect())
}

/// Implements a language with `expando_char` / `pre_process_pattern`.
/// Use when the language does NOT accept `$` as a valid identifier character.
macro_rules! impl_lang_expando {
	($lang:ident, $func:ident, $char:expr) => {
		#[derive(Clone, Copy, Debug)]
		pub struct $lang;
		impl Language for $lang {
			fn kind_to_id(&self, kind: &str) -> u16 {
				self.get_ts_language().id_for_node_kind(kind, true)
			}

			fn field_to_id(&self, field: &str) -> Option<u16> {
				self
					.get_ts_language()
					.field_id_for_name(field)
					.map(|f| f.get())
			}

			fn expando_char(&self) -> char {
				$char
			}

			fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
				pre_process_pattern(self.expando_char(), query)
			}

			fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
				builder.build(|src| StrDoc::try_new(src, *self))
			}
		}
		impl LanguageExt for $lang {
			fn get_ts_language(&self) -> TSLanguage {
				parsers::$func().into()
			}
		}
	};
}

// ── Customized languages with expando_char ──────────────────────────────

impl_lang_expando!(C, language_c, '𐀀');
impl_lang_expando!(Cpp, language_cpp, '𐀀');
impl_lang_expando!(CSharp, language_c_sharp, 'µ');
impl_lang_expando!(Cmake, language_cmake, 'µ');
impl_lang_expando!(Css, language_css, '_');
impl_lang_expando!(Dockerfile, language_dockerfile, 'µ');
impl_lang_expando!(Elixir, language_elixir, 'µ');
impl_lang_expando!(Erlang, language_erlang, 'µ');
impl_lang_expando!(Fortran, language_fortran, '𐀀');
impl_lang_expando!(Go, language_go, 'µ');
impl_lang!(Graphql, language_graphql);
impl_lang_expando!(Haskell, language_haskell, 'µ');
impl_lang_expando!(Hcl, language_hcl, 'µ');
impl_lang_expando!(Ini, language_ini, 'µ');
impl_lang_expando!(Just, language_just, 'µ');
impl_lang_expando!(Kotlin, language_kotlin, 'µ');
impl_lang_expando!(Nix, language_nix, '_');
impl_lang_expando!(Ocaml, language_ocaml, 'µ');
impl_lang_expando!(Php, language_php, 'µ');
impl_lang_expando!(Powershell, language_powershell, 'µ');
impl_lang_expando!(Proto, language_proto, 'µ');
impl_lang_expando!(Python, language_python, 'µ');
impl_lang_expando!(R, language_r, 'µ');
impl_lang_expando!(Ruby, language_ruby, 'µ');
impl_lang_expando!(Rust, language_rust, 'µ');
impl_lang_expando!(Sql, language_sql, 'µ');
impl_lang_expando!(Swift, language_swift, 'µ');

// New expando languages
impl_lang_expando!(Make, language_make, 'µ');
impl_lang_expando!(ObjC, language_objc, '𐀀');
impl_lang_expando!(Starlark, language_starlark, 'µ');
impl_lang_expando!(Odin, language_odin, 'µ');
impl_lang_expando!(Julia, language_julia, 'µ');
impl_lang_expando!(Verilog, language_verilog, 'µ');
impl_lang_expando!(Zig, language_zig, 'µ');
impl_lang_expando!(Tlaplus, language_tlaplus, 'µ');

// ── Stub languages ($ accepted in grammar) ──────────────────────────────

impl_lang!(Astro, language_astro);
impl_lang!(Bash, language_bash);
impl_lang!(Clojure, language_clojure);
impl_lang!(Java, language_java);
impl_lang!(JavaScript, language_javascript);
impl_lang!(Json, language_json);
impl_lang!(Lua, language_lua);
impl_lang!(Scala, language_scala);
impl_lang!(Solidity, language_solidity);
impl_lang!(Svelte, language_svelte);
impl_lang!(Tsx, language_tsx);
impl_lang!(TypeScript, language_typescript);
impl_lang!(Vue, language_vue);
impl_lang!(Yaml, language_yaml);

// New stub languages
impl_lang!(Markdown, language_markdown);
impl_lang!(Toml, language_toml);
impl_lang!(Diff, language_diff);
impl_lang!(Xml, language_xml);
impl_lang!(Regex, language_regex);
impl_lang!(Dart, language_dart);
impl_lang!(EmacsLisp, language_elisp);

// ── Html (custom implementation) ──────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub struct Html;

impl Language for Html {
	fn expando_char(&self) -> char {
		'z'
	}

	fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
		pre_process_pattern(self.expando_char(), query)
	}

	fn kind_to_id(&self, kind: &str) -> u16 {
		self.get_ts_language().id_for_node_kind(kind, true)
	}

	fn field_to_id(&self, field: &str) -> Option<u16> {
		self
			.get_ts_language()
			.field_id_for_name(field)
			.map(|f| f.get())
	}

	fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
		builder.build(|src| StrDoc::try_new(src, *self))
	}
}

impl LanguageExt for Html {
	fn get_ts_language(&self) -> TSLanguage {
		parsers::language_html()
	}
}

// ── SupportLang enum ────────────────────────────────────────────────────

/// All supported languages for ast-grep structural search/replace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SupportLang {
	Astro,
	Bash,
	C,
	Cmake,
	Cpp,
	CSharp,
	Dart,
	Clojure,
	Css,
	Diff,
	Dockerfile,
	EmacsLisp,
	Elixir,
	Erlang,
	Fortran,
	Go,
	Graphql,
	Haskell,
	Hcl,
	Html,
	Ini,
	Java,
	JavaScript,
	Json,
	Just,
	Julia,
	Kotlin,
	Lua,
	Make,
	Markdown,
	Nix,
	ObjC,
	Ocaml,
	Odin,
	Php,
	Powershell,
	Proto,
	Python,
	R,
	Regex,
	Ruby,
	Rust,
	Scala,
	Solidity,
	Sql,
	Starlark,
	Svelte,
	Swift,
	Toml,
	Tlaplus,
	Tsx,
	TypeScript,
	Verilog,
	Vue,
	Xml,
	Yaml,
	Zig,
}

static SORTED_ALIASES: LazyLock<Box<[&'static str]>> = LazyLock::new(|| {
	let mut aliases = LANG_ALIASES.keys().copied().collect::<Box<[_]>>();
	aliases.sort_unstable();
	aliases
});

impl SupportLang {
	pub const fn all_langs() -> &'static [Self] {
		use SupportLang::*;
		&[
			Astro, Bash, C, Cmake, Cpp, CSharp, Dart, Clojure, Css, Diff, Dockerfile, EmacsLisp,
			Elixir, Erlang, Fortran, Go, Graphql, Haskell, Hcl, Html, Ini, Java, JavaScript, Json,
			Just, Julia, Kotlin, Lua, Make, Markdown, Nix, ObjC, Ocaml, Odin, Php, Powershell, Proto,
			Python, R, Regex, Ruby, Rust, Scala, Solidity, Sql, Starlark, Svelte, Swift, Toml,
			Tlaplus, Tsx, TypeScript, Verilog, Vue, Xml, Yaml, Zig,
		]
	}

	/// The canonical lowercase name used as a stable key in alias maps,
	/// file-type inference results, and error messages.
	pub const fn canonical_name(self) -> &'static str {
		match self {
			Self::Astro => "astro",
			Self::Bash => "bash",
			Self::C => "c",
			Self::Cmake => "cmake",
			Self::Cpp => "cpp",
			Self::CSharp => "csharp",
			Self::Dart => "dart",
			Self::Clojure => "clojure",
			Self::Css => "css",
			Self::Diff => "diff",
			Self::Dockerfile => "dockerfile",
			Self::EmacsLisp => "emacs-lisp",
			Self::Elixir => "elixir",
			Self::Erlang => "erlang",
			Self::Fortran => "fortran",
			Self::Go => "go",
			Self::Graphql => "graphql",
			Self::Haskell => "haskell",
			Self::Hcl => "hcl",
			Self::Html => "html",
			Self::Ini => "ini",
			Self::Java => "java",
			Self::JavaScript => "javascript",
			Self::Json => "json",
			Self::Just => "just",
			Self::Julia => "julia",
			Self::Kotlin => "kotlin",
			Self::Lua => "lua",
			Self::Make => "make",
			Self::Markdown => "markdown",
			Self::Nix => "nix",
			Self::ObjC => "objc",
			Self::Ocaml => "ocaml",
			Self::Odin => "odin",
			Self::Php => "php",
			Self::Powershell => "powershell",
			Self::Proto => "protobuf",
			Self::Python => "python",
			Self::R => "r",
			Self::Regex => "regex",
			Self::Ruby => "ruby",
			Self::Rust => "rust",
			Self::Scala => "scala",
			Self::Solidity => "solidity",
			Self::Sql => "sql",
			Self::Starlark => "starlark",
			Self::Svelte => "svelte",
			Self::Swift => "swift",
			Self::Toml => "toml",
			Self::Tlaplus => "tlaplus",
			Self::Tsx => "tsx",
			Self::TypeScript => "typescript",
			Self::Verilog => "verilog",
			Self::Vue => "vue",
			Self::Xml => "xml",
			Self::Yaml => "yaml",
			Self::Zig => "zig",
		}
	}

	pub fn from_alias(value: &str) -> Option<Self> {
		let lowered = value.trim().to_ascii_lowercase();
		LANG_ALIASES.get(lowered.as_str()).copied()
	}

	pub fn from_path(path: &Path) -> Option<Self> {
		from_extension(path)
	}

	pub fn sorted_aliases() -> &'static [&'static str] {
		&SORTED_ALIASES
	}
}

impl fmt::Display for SupportLang {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{self:?}")
	}
}

// ── Dispatch macro ──────────────────────────────────────────────────────

macro_rules! execute_lang_method {
	($me:expr, $method:ident, $($pname:tt),*) => {
		use SupportLang as S;
		match *$me {
			S::Astro => Astro.$method($($pname,)*),
			S::Bash => Bash.$method($($pname,)*),
			S::C => C.$method($($pname,)*),
			S::Cmake => Cmake.$method($($pname,)*),
			S::Cpp => Cpp.$method($($pname,)*),
			S::CSharp => CSharp.$method($($pname,)*),
			S::Dart => Dart.$method($($pname,)*),
			S::Clojure => Clojure.$method($($pname,)*),
			S::Css => Css.$method($($pname,)*),
			S::Diff => Diff.$method($($pname,)*),
			S::Dockerfile => Dockerfile.$method($($pname,)*),
			S::EmacsLisp => EmacsLisp.$method($($pname,)*),
			S::Elixir => Elixir.$method($($pname,)*),
			S::Erlang => Erlang.$method($($pname,)*),
			S::Fortran => Fortran.$method($($pname,)*),
			S::Go => Go.$method($($pname,)*),
			S::Graphql => Graphql.$method($($pname,)*),
			S::Haskell => Haskell.$method($($pname,)*),
			S::Hcl => Hcl.$method($($pname,)*),
			S::Html => Html.$method($($pname,)*),
			S::Ini => Ini.$method($($pname,)*),
			S::Java => Java.$method($($pname,)*),
			S::JavaScript => JavaScript.$method($($pname,)*),
			S::Json => Json.$method($($pname,)*),
			S::Just => Just.$method($($pname,)*),
			S::Julia => Julia.$method($($pname,)*),
			S::Kotlin => Kotlin.$method($($pname,)*),
			S::Lua => Lua.$method($($pname,)*),
			S::Make => Make.$method($($pname,)*),
			S::Markdown => Markdown.$method($($pname,)*),
			S::Nix => Nix.$method($($pname,)*),
			S::ObjC => ObjC.$method($($pname,)*),
			S::Ocaml => Ocaml.$method($($pname,)*),
			S::Odin => Odin.$method($($pname,)*),
			S::Php => Php.$method($($pname,)*),
			S::Powershell => Powershell.$method($($pname,)*),
			S::Proto => Proto.$method($($pname,)*),
			S::Python => Python.$method($($pname,)*),
			S::R => R.$method($($pname,)*),
			S::Regex => Regex.$method($($pname,)*),
			S::Ruby => Ruby.$method($($pname,)*),
			S::Rust => Rust.$method($($pname,)*),
			S::Scala => Scala.$method($($pname,)*),
			S::Solidity => Solidity.$method($($pname,)*),
			S::Sql => Sql.$method($($pname,)*),
			S::Starlark => Starlark.$method($($pname,)*),
			S::Svelte => Svelte.$method($($pname,)*),
			S::Swift => Swift.$method($($pname,)*),
			S::Toml => Toml.$method($($pname,)*),
			S::Tlaplus => Tlaplus.$method($($pname,)*),
			S::Tsx => Tsx.$method($($pname,)*),
			S::TypeScript => TypeScript.$method($($pname,)*),
			S::Verilog => Verilog.$method($($pname,)*),
			S::Vue => Vue.$method($($pname,)*),
			S::Xml => Xml.$method($($pname,)*),
			S::Yaml => Yaml.$method($($pname,)*),
			S::Zig => Zig.$method($($pname,)*),
		}
	};
}

macro_rules! impl_lang_method {
	($method:ident, ($($pname:tt: $ptype:ty),*) => $return_type:ty) => {
		#[inline]
		fn $method(&self, $($pname: $ptype),*) -> $return_type {
			execute_lang_method! { self, $method, $($pname),* }
		}
	};
}

impl Language for SupportLang {
	impl_lang_method!(kind_to_id, (kind: &str) => u16);

	impl_lang_method!(field_to_id, (field: &str) => Option<u16>);

	impl_lang_method!(meta_var_char, () => char);

	impl_lang_method!(expando_char, () => char);

	impl_lang_method!(extract_meta_var, (source: &str) => Option<MetaVariable>);

	impl_lang_method!(build_pattern, (builder: &PatternBuilder) => Result<Pattern, PatternError>);

	fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
		execute_lang_method! { self, pre_process_pattern, query }
	}

	fn from_path<P: AsRef<Path>>(path: P) -> Option<Self> {
		from_extension(path.as_ref())
	}
}

impl LanguageExt for SupportLang {
	impl_lang_method!(get_ts_language, () => TSLanguage);
}

// ── File extension mapping ──────────────────────────────────────────────

const fn extensions(lang: SupportLang) -> &'static [&'static str] {
	use SupportLang::*;
	match lang {
		Astro => &["astro"],
		Bash => {
			&["bash", "bats", "cgi", "command", "env", "fcgi", "ksh", "sh", "tmux", "tool", "zsh"]
		},
		C => &["c", "h"],
		Cmake => &["cmake"],
		Cpp => &["cc", "hpp", "cpp", "c++", "hh", "cxx", "cu", "ino"],
		CSharp => &["cs"],
		Dart => &["dart"],
		Clojure => &["clj", "cljs", "cljc", "edn"],
		Css => &["css", "scss"],
		Diff => &["diff", "patch"],
		Dockerfile => &["dockerfile"],
		EmacsLisp => &["el"],
		Elixir => &["ex", "exs"],
		Erlang => &["erl", "hrl"],
		Fortran => &["f90", "F90", "f95", "F95", "f03", "F03", "f08", "F08"],
		Go => &["go"],
		Graphql => &["graphql", "gql"],
		Haskell => &["hs"],
		Hcl => &["hcl", "tf", "tfvars"],
		Html => &["html", "htm", "xhtml"],
		Ini => &["ini", "cfg", "conf", "properties"],
		Java => &["java"],
		JavaScript => &["cjs", "js", "mjs", "jsx"],
		Json => &["json"],
		Just => &[],
		Julia => &["jl"],
		Kotlin => &["kt", "ktm", "kts"],
		Lua => &["lua"],
		Make => &["mk", "mak"],
		Markdown => &["md", "markdown", "mdx"],
		Nix => &["nix"],
		ObjC => &["m"],
		Ocaml => &["ml"],
		Odin => &["odin"],
		Php => &["php"],
		Powershell => &["ps1", "psm1"],
		Proto => &["proto"],
		Python => &["py", "py3", "pyi", "bzl"],
		R => &["r"],
		Regex => &[],
		Ruby => &["rb", "rbw", "gemspec"],
		Rust => &["rs"],
		Scala => &["scala", "sc", "sbt"],
		Solidity => &["sol"],
		Sql => &["sql"],
		Starlark => &["star", "bzl"],
		Svelte => &["svelte"],
		Swift => &["swift"],
		Toml => &["toml"],
		Tlaplus => &["tla"],
		Tsx => &["tsx"],
		TypeScript => &["ts", "cts", "mts"],
		Verilog => &["v", "sv", "svh", "vh"],
		Vue => &["vue"],
		Xml => &["xml", "xsl", "xslt", "svg", "plist"],
		Yaml => &["yaml", "yml"],
		Zig => &["zig"],
	}
}

/// Guess language from file extension.
fn from_extension(path: &Path) -> Option<SupportLang> {
	let name = path.file_name()?.to_str()?;
	if name == "Makefile" || name == "makefile" || name == "GNUmakefile" {
		return Some(SupportLang::Make);
	}
	if name == "Justfile" || name == "justfile" {
		return Some(SupportLang::Just);
	}
	if name == "CMakeLists.txt" {
		return Some(SupportLang::Cmake);
	}
	if name == "Dockerfile"
		|| name == "dockerfile"
		|| name.starts_with("Dockerfile.")
		|| name.starts_with("dockerfile.")
		|| name == "Containerfile"
		|| name == "containerfile"
	{
		return Some(SupportLang::Dockerfile);
	}
	if name == ".emacs" {
		return Some(SupportLang::EmacsLisp);
	}

	// Extensionless shell rc/profile files. `Path::extension` returns `None`
	// for both bare (`zshrc`) and dotfile (`.zshrc`) forms, so they would
	// otherwise resolve to no language and disable block-aware ops on them.
	let stem = name.strip_prefix('.').unwrap_or(name);
	if matches!(
		stem,
		"zshrc"
			| "zshenv"
			| "zprofile"
			| "zlogin"
			| "zlogout"
			| "zsh_aliases"
			| "bashrc"
			| "bash_profile"
			| "bash_login"
			| "bash_logout"
			| "bash_aliases"
			| "profile"
			| "kshrc"
			| "mkshrc"
			| "shrc"
	) {
		return Some(SupportLang::Bash);
	}

	let ext = path.extension()?.to_str()?;
	SupportLang::all_langs()
		.iter()
		.copied()
		.find(|&l| extensions(l).contains(&ext))
}

static LANG_ALIASES: phf::Map<&'static str, SupportLang> = phf_map! {
"astro"          => SupportLang::Astro,
"bash"           => SupportLang::Bash,
"sh"             => SupportLang::Bash,
"zsh"            => SupportLang::Bash,
"ksh"            => SupportLang::Bash,
"bats"           => SupportLang::Bash,
"c"              => SupportLang::C,
"h"              => SupportLang::C,
"cmake"          => SupportLang::Cmake,
"cpp"            => SupportLang::Cpp,
"c++"            => SupportLang::Cpp,
"cc"             => SupportLang::Cpp,
"cxx"            => SupportLang::Cpp,
"hh"             => SupportLang::Cpp,
"hpp"            => SupportLang::Cpp,
"cu"             => SupportLang::Cpp,
"ino"            => SupportLang::Cpp,
"csharp"         => SupportLang::CSharp,
"c#"             => SupportLang::CSharp,
"cs"             => SupportLang::CSharp,
"dart"           => SupportLang::Dart,
"css"            => SupportLang::Css,
"clj"            => SupportLang::Clojure,
"cljc"           => SupportLang::Clojure,
"cljs"           => SupportLang::Clojure,
"clojure"        => SupportLang::Clojure,
"clojurescript"  => SupportLang::Clojure,
"edn"            => SupportLang::Clojure,
"diff"           => SupportLang::Diff,
"patch"          => SupportLang::Diff,
"docker"         => SupportLang::Dockerfile,
"dockerfile"     => SupportLang::Dockerfile,
"containerfile"  => SupportLang::Dockerfile,
"emacs-lisp"     => SupportLang::EmacsLisp,
"emacslisp"      => SupportLang::EmacsLisp,
"elisp"          => SupportLang::EmacsLisp,
"el"             => SupportLang::EmacsLisp,
"elixir"         => SupportLang::Elixir,
"ex"             => SupportLang::Elixir,
"exs"            => SupportLang::Elixir,
"erlang"         => SupportLang::Erlang,
"erl"            => SupportLang::Erlang,
"hrl"            => SupportLang::Erlang,
"fortran"        => SupportLang::Fortran,
"f90"            => SupportLang::Fortran,
"f95"            => SupportLang::Fortran,
"f03"            => SupportLang::Fortran,
"f08"            => SupportLang::Fortran,
"go"             => SupportLang::Go,
"golang"         => SupportLang::Go,
"graphql"        => SupportLang::Graphql,
"gql"            => SupportLang::Graphql,
"haskell"        => SupportLang::Haskell,
"hs"             => SupportLang::Haskell,
"hcl"            => SupportLang::Hcl,
"tf"             => SupportLang::Hcl,
"tfvars"         => SupportLang::Hcl,
"terraform"      => SupportLang::Hcl,
"html"           => SupportLang::Html,
"htm"            => SupportLang::Html,
"xhtml"          => SupportLang::Html,
"ini"            => SupportLang::Ini,
"cfg"            => SupportLang::Ini,
"conf"           => SupportLang::Ini,
"config"         => SupportLang::Ini,
"properties"     => SupportLang::Ini,
"java"           => SupportLang::Java,
"javascript"     => SupportLang::JavaScript,
"js"             => SupportLang::JavaScript,
"jsx"            => SupportLang::JavaScript,
"mjs"            => SupportLang::JavaScript,
"cjs"            => SupportLang::JavaScript,
"json"           => SupportLang::Json,
"just"           => SupportLang::Just,
"justfile"       => SupportLang::Just,
"julia"          => SupportLang::Julia,
"jl"             => SupportLang::Julia,
"kotlin"         => SupportLang::Kotlin,
"kt"             => SupportLang::Kotlin,
"kts"            => SupportLang::Kotlin,
"ktm"            => SupportLang::Kotlin,
"lua"            => SupportLang::Lua,
"make"           => SupportLang::Make,
"makefile"       => SupportLang::Make,
"gnumake"        => SupportLang::Make,
"mk"             => SupportLang::Make,
"mak"            => SupportLang::Make,
"markdown"       => SupportLang::Markdown,
"md"             => SupportLang::Markdown,
"mdx"            => SupportLang::Markdown,
"nix"            => SupportLang::Nix,
"objc"           => SupportLang::ObjC,
"obj-c"          => SupportLang::ObjC,
"objective-c"    => SupportLang::ObjC,
"m"              => SupportLang::ObjC,
"mm"             => SupportLang::ObjC,
"ocaml"          => SupportLang::Ocaml,
"ml"             => SupportLang::Ocaml,
"odin"           => SupportLang::Odin,
"php"            => SupportLang::Php,
"powershell"     => SupportLang::Powershell,
"ps1"            => SupportLang::Powershell,
"psm1"           => SupportLang::Powershell,
"protobuf"       => SupportLang::Proto,
"proto"          => SupportLang::Proto,
"python"         => SupportLang::Python,
"py"             => SupportLang::Python,
"py3"            => SupportLang::Python,
"pyi"            => SupportLang::Python,
"r"              => SupportLang::R,
"regex"          => SupportLang::Regex,
"re"             => SupportLang::Regex,
"ruby"           => SupportLang::Ruby,
"rb"             => SupportLang::Ruby,
"rbw"            => SupportLang::Ruby,
"gemspec"        => SupportLang::Ruby,
"rust"           => SupportLang::Rust,
"rs"             => SupportLang::Rust,
"scala"          => SupportLang::Scala,
"sc"             => SupportLang::Scala,
"sbt"            => SupportLang::Scala,
"solidity"       => SupportLang::Solidity,
"sol"            => SupportLang::Solidity,
"sql"            => SupportLang::Sql,
"starlark"       => SupportLang::Starlark,
"star"           => SupportLang::Starlark,
"bzl"            => SupportLang::Starlark,
"bazel"          => SupportLang::Starlark,
"skylark"        => SupportLang::Starlark,
"svelte"         => SupportLang::Svelte,
"swift"          => SupportLang::Swift,
"toml"           => SupportLang::Toml,
"tla"            => SupportLang::Tlaplus,
"tla+"           => SupportLang::Tlaplus,
"tlaplus"        => SupportLang::Tlaplus,
"pluscal"        => SupportLang::Tlaplus,
"pcal"           => SupportLang::Tlaplus,
"tsx"            => SupportLang::Tsx,
"typescript"     => SupportLang::TypeScript,
"ts"             => SupportLang::TypeScript,
"mts"            => SupportLang::TypeScript,
"cts"            => SupportLang::TypeScript,
"verilog"        => SupportLang::Verilog,
"systemverilog"  => SupportLang::Verilog,
"sv"             => SupportLang::Verilog,
"svh"            => SupportLang::Verilog,
"vh"             => SupportLang::Verilog,
"v"              => SupportLang::Verilog,
"vue"            => SupportLang::Vue,
"xml"            => SupportLang::Xml,
"xsl"            => SupportLang::Xml,
"xslt"           => SupportLang::Xml,
"svg"            => SupportLang::Xml,
"plist"          => SupportLang::Xml,
"yaml"           => SupportLang::Yaml,
"yml"            => SupportLang::Yaml,
"zig"            => SupportLang::Zig,
};
