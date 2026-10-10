#![allow(dead_code)]
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use serde_json::{Value, json};

static TRACK: AtomicBool = AtomicBool::new(false);
static BYTES: AtomicUsize = AtomicUsize::new(0);
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
struct Counter;
unsafe impl GlobalAlloc for Counter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) { BYTES.fetch_add(layout.size(), Ordering::Relaxed); ALLOCS.fetch_add(1, Ordering::Relaxed); }
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) { unsafe { System.dealloc(ptr, layout) } }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) { BYTES.fetch_add(layout.size(), Ordering::Relaxed); ALLOCS.fetch_add(1, Ordering::Relaxed); }
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) { BYTES.fetch_add(size, Ordering::Relaxed); ALLOCS.fetch_add(1, Ordering::Relaxed); }
        unsafe { System.realloc(ptr, layout, size) }
    }
}
#[global_allocator] static ALLOCATOR: Counter = Counter;
mod minimizer {
    #[derive(Default)] pub struct MinimizerConfig { pub enabled: bool, pub _unused: bool }
    pub struct MinimizerCtx<'a> { pub program: &'a str, pub subcommand: Option<&'a str>, pub command: &'a str, pub config: &'a MinimizerConfig }
    pub struct MinimizerOutput { pub text: String, pub changed: bool, pub input_bytes: usize, pub output_bytes: usize }
    impl MinimizerOutput {
        pub fn passthrough(text: &str) -> Self { Self {text: text.to_string(), changed: false, input_bytes: text.len(), output_bytes:text.len()} }
        pub fn transformed(text: String, input_bytes: usize) -> Self { let output_bytes = text.len(); Self{text, changed:true, input_bytes,output_bytes} }
    }
    pub mod primitives { include!("primitives.rs"); }
    pub mod cloud { include!("selected_cloud.rs"); }
}
fn corpus() -> Vec<Value> {
    let mut cases = vec![
        json!({"Policy":[{"Name":"SECRET_POLICY"}], "Things":[{"Name":"visible", "Status":"ready", "Password":"SECRET_DIRECT", "id":{"Password":"SECRET_NESTED", "x":[{"Token":"SECRET_DEEP"}]}, "Arn":[{"Credentials":"SECRET_ARRAY"},null]}]}),
        json!({"A":[], "B":[null,1,"x",[],false], "C":[null,{"Name":"first"},false,{"Name":"second","Status":true}], "D":[{"Name":"wrong"}]}),
        json!({"A":[{},null,{}],"B":[{"Name":"wrong"}]}),
        json!({"Things":[{"other":"unknown","Password":"SECRET"}]}),
        json!({"things":[{"Name":null,"Status":7,"Arn":false,"type":[],"engine":{},"version":"v"}]}),
        json!({"Things":[{"Name":"a","Id":"id","Arn":"arn","Status":"s","State":"st","Created":"today","Version":"not-shown"}]}),
        json!({"things":[{}, {"Status":"late"}, {"Name":"last"}]}),
        json!({"ResponseMetadata":[{"Name":"SECRET_META"}],"Credentials":[{"Name":"SECRET_CREDS"}],"things":[{"Name":"safe","policy":"case-sensitive-kept","Password":"SECRET"}]}),
        json!([{"Name":"root-array"}]), json!({}), json!({"Things":[{"name":[{"Password":"SECRET"},{"Token":"SECRET"}],"state":{"Credentials":{"Password":"SECRET"}}}]}),
    ];
    let mut rows = vec![json!(null), json!("ignored")];
    for i in 0..45 { let mut row = json!({"Name":format!("row-{i}")}); if i == 44 { row["Status"] = json!("late-column"); } rows.push(row); }
    cases.push(json!({"Things":rows}));
    cases
}
fn generic(root: &Value) -> Option<String> { minimizer::cloud::compact_generic_for_measurement(root) }
fn full(input: &str) -> String {
    let cfg = minimizer::MinimizerConfig { enabled:true, ..Default::default() };
    let ctx = minimizer::MinimizerCtx { program:"aws",subcommand:Some("unknown"),command:"aws unknown list",config:&cfg };
    minimizer::cloud::filter(&ctx,input,0).text
}
fn fixture(rows: usize, payload: usize) -> Value {
    let data = "x".repeat(payload);
    json!({"Unselected":{"large":data},"Things":(0..rows).map(|i|json!({"Name":format!("row-{i}"),"Status":"ready","ignored":{"payload":data,"nested":[{"Token":"SECRET_NESTED"}, {"visible":true}]},"Password":"SECRET_DIRECT"})).collect::<Vec<_>>()})
}
fn allocated(root: &Value) -> (Option<String>,usize,usize) {
    BYTES.store(0,Ordering::Relaxed); ALLOCS.store(0,Ordering::Relaxed); TRACK.store(true,Ordering::Relaxed);
    let out = generic(root);
    TRACK.store(false,Ordering::Relaxed);
    (out,BYTES.load(Ordering::Relaxed),ALLOCS.load(Ordering::Relaxed))
}
fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(||"verify".to_string());
    let oracle_path = std::env::args().nth(2).unwrap_or_else(||"/tmp/omp-perf-validation/frozen-output.json".to_string());
    let outputs: Vec<Value> = corpus().iter().map(|root|json!({"generic":generic(root),"filter":full(&root.to_string())})).collect();
    if mode == "freeze" { std::fs::write(&oracle_path,serde_json::to_string_pretty(&outputs).unwrap()).unwrap(); }
    else { let frozen:Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&oracle_path).unwrap()).unwrap(); assert_eq!(outputs,frozen,"frozen corpus parity"); }
    let root = fixture(1000,1024);
    let (out,bytes,allocs) = allocated(&root);
    assert_eq!(out.as_deref().unwrap().lines().count(),42);
    assert!(out.as_deref().unwrap().ends_with("[…960 Things elided…]\n"));
    assert!(!out.as_deref().unwrap().contains("SECRET"));
    println!("{}",json!({"mode":mode,"corpus":outputs.len(),"rows":1000,"payload_bytes_total":1001*1024,"input_json_bytes":root.to_string().len(),"generic_allocated_bytes":bytes,"generic_allocations":allocs,"output_bytes":out.as_deref().unwrap().len()}));
    if mode == "regression" { assert!(bytes < 256 * 1024,"generic fallback allocated {bytes} bytes for capped output with 1,025,024 unrendered payload bytes (limit 262144)"); }
    if mode == "bench" {
        for (rows,payload) in [(10,32),(1000,1024),(4000,512)] {
            let root=fixture(rows,payload); let input=root.to_string();
            for _ in 0..10 { std::hint::black_box(generic(&root)); std::hint::black_box(full(&input)); }
            let mut generic_us=Vec::new(); let mut filter_us=Vec::new();
            for _ in 0..31 { let start=std::time::Instant::now(); for _ in 0..10 { std::hint::black_box(generic(&root)); } generic_us.push(start.elapsed().as_nanos() as f64/10000.0); let start=std::time::Instant::now(); for _ in 0..10 { std::hint::black_box(full(&input)); } filter_us.push(start.elapsed().as_nanos() as f64/10000.0); }
            generic_us.sort_by(f64::total_cmp);filter_us.sort_by(f64::total_cmp);
            let (_,bytes,allocs)=allocated(&root);
            println!("{}",json!({"rows":rows,"payload_each":payload,"input_json_bytes":input.len(),"allocated_bytes":bytes,"allocations":allocs,"generic_median_us":generic_us[15],"filter_parse_included_median_us":filter_us[15],"generic_samples_us":generic_us,"filter_samples_us":filter_us}));
        }
    }
}
