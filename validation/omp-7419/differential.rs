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
    pub mod baseline { include!("baseline_cloud.rs"); }
    pub mod candidate { include!("candidate_cloud.rs"); }
}

const SENSITIVE: &[&str] = &["Policy", "PolicyDocument", "AssumeRolePolicyDocument", "Environment", "SecretString", "SecretBinary", "Token", "SessionToken", "Credentials", "Password", "PrivateKey", "KeyMaterial", "PlaintextKeyMaterial", "CiphertextBlob", "ResponseMetadata"];
const KEYS: &[&str] = &["Id", "Name", "Arn", "Status", "State", "Created", "Modified", "Type", "Engine", "Version", "SomeId", "FunctionName", "FooArn", "FooStatus", "FooState", "dateCreatedAt", "dateModifiedAt", "unknown", "PASSWORD", "policy", "Token", "Password", "Credentials", "Environment", "SecretString", "ResponseMetadata", "", "NAME", "name", "id", "🤖Name", "has\tName"];
struct Rng(u64);
impl Rng { fn get(&mut self,n:usize)->usize { self.0=self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); ((self.0>>24) as usize)%n } }
fn value(r:&mut Rng,depth:usize)->Value {
 match r.get(if depth == 0 {5} else {7}) {
  0=>Value::Null, 1=>json!(r.get(2)==0), 2=>json!((r.get(2000) as i64)-1000),
  3=>json!(format!("text-{}-\t-\n-\r-\u{1b}[31m-Ω",r.get(999))), 4=>json!(1.25),
  5=>Value::Array((0..r.get(5)).map(|_|value(r,depth-1)).collect()),
  _=>{let mut m=serde_json::Map::new();for _ in 0..r.get(7){let k=KEYS[r.get(KEYS.len())];m.insert(k.to_owned(),value(r,depth-1));}Value::Object(m)}
 }
}
fn compare(label:&str, root:&Value, checks:&mut usize) {
 let old=minimizer::baseline::compact_generic_for_measurement(root);
 let new=minimizer::candidate::compact_generic_for_measurement(root);
 assert_eq!(old,new,"generic mismatch {label}: {root}");
 let input=root.to_string();let cfg=minimizer::MinimizerConfig{enabled:true, ..Default::default()};
 for (sub,command) in [(Some("unknown"),"aws unknown list"),(None,"aws"),(Some("s3"),"aws s3 ls"),(Some("sts"),"aws sts unknown"),(Some("lambda"),"aws lambda list-functions")] {
  let ctx=minimizer::MinimizerCtx{program:"aws",subcommand:sub,command,config:&cfg};
  for exit in [0,1] {
   let old=minimizer::baseline::filter(&ctx,&input,exit);let new=minimizer::candidate::filter(&ctx,&input,exit);
   assert_eq!((&old.text,old.changed,old.input_bytes,old.output_bytes),(&new.text,new.changed,new.input_bytes,new.output_bytes),"filter mismatch {label} command={command} exit={exit}: {root}");
   *checks+=1;
  }
 }
 *checks+=1;
}
fn main(){
 let mut checks=0usize;let mut cases=0usize;
 for &s in SENSITIVE {
  for depth in 0..8 {
   let mut nested=json!({s:"LEAK_SENTINEL"});
   for _ in 0..depth {nested=json!({"Name":[nested],s:"LEAK_SENTINEL"});}
   let mut row=serde_json::Map::new();row.insert(s.to_string(),json!("LEAK_SENTINEL"));row.insert("Name".to_string(),nested);row.insert("Status".to_string(),json!([{s:"LEAK_SENTINEL"},null]));
   let root=json!({s:[{"Name":"LEAK_SENTINEL"}],"Things":[Value::Object(row)]});
   compare(&format!("sensitive {s} depth {depth}"),&root,&mut checks);cases+=1;
   let text=minimizer::candidate::compact_generic_for_measurement(&root).unwrap();assert!(!text.contains("LEAK_SENTINEL"));
  }
  for key in [s.to_string(),s.to_lowercase(),s.to_uppercase()] {let root=json!({key.clone():[{"Name":"sentinel"}],"Things":[{"Name":"safe"}]});compare(&format!("case-sensitive {key}"),&root,&mut checks);cases+=1;}
 }
 for n in [0usize,1,2,39,40,41,45,1000] {
  for late in [0,n.saturating_sub(1)] {
   let mut rows=vec![Value::Null,json!(false),json!([])];
   for i in 0..n {rows.push(if i==late {json!({"Name":i,"Status":null,"Created":[],"Id":{},"Type":false,"Engine":1,"Version":"seventh"})}else{json!({"Name":i})});rows.push(Value::Null);}
   let root=json!({"Empty":[],"Scalars":[null,false,1],"Things":rows,"Later":[{"Name":"not chosen"}]});compare(&format!("row boundary {n} late {late}"),&root,&mut checks);cases+=1;
  }
 }
 let mut r=Rng(0xc0ffee123456789);
 for i in 0..3000 {
  let root=if i%5==0 {value(&mut r,4)} else {
   let mut top=serde_json::Map::new();for arr in 0..1+r.get(5) {
    let name=match r.get(6){0=>SENSITIVE[r.get(SENSITIVE.len())].to_string(),1=>"events".to_string(),2=>"Items".to_string(),_=>format!("Things{arr}")};
    let mut rows=Vec::new();for _ in 0..r.get(65) {
     if r.get(6)==0 {rows.push(value(&mut r,3));}else{let mut m=serde_json::Map::new();for _ in 0..r.get(12){let k=KEYS[r.get(KEYS.len())];m.insert(k.to_string(),value(&mut r,3));}rows.push(Value::Object(m));}
    }top.insert(name,Value::Array(rows));
   }Value::Object(top)
  };
  compare(&format!("random {i}"),&root,&mut checks);cases+=1;
 }
 println!("PASS: {cases} adversarial fixtures, {checks} exact baseline/candidate generic and public-filter comparisons; all 15 sensitive keys tested at nested depths 0..7.");
}
