import os, sys, subprocess, time, json, pathlib, resource, signal, hashlib, datetime
root=pathlib.Path(sys.argv[1]).resolve()
label='formatting'
repo=root
out=pathlib.Path(sys.argv[2]).resolve()
out.mkdir(exist_ok=False)
pub='eabb97c9274f8d0e4354989538442d2d9d7aa1bb'
base='b07a1c146d0d12cfc855a2c65d52f892ef319040'
def git(*args):
 return subprocess.check_output(['git',*args],cwd=repo,text=True).strip()
def manifest():
 paths=set(git('diff','--name-only',base,'HEAD').splitlines())
 paths.update(['AGENTS.md','package.json','bun.lock','packages/coding-agent/package.json','packages/coding-agent/tsconfig.json','packages/tsconfig.workspace.json'])
 rows=[]
 for path in sorted(paths):
  p=repo/path
  if p.is_file():
   stat=p.stat()
   rows.append({'path':path,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'uid':stat.st_uid,'gid':stat.st_gid,'mode':oct(stat.st_mode & 0o777)})
 return {'head':git('rev-parse','HEAD'),'tree':git('rev-parse','HEAD^{tree}'),'published':pub,'published_tree':git('rev-parse',pub+'^{tree}'),'status':git('status','--porcelain=v1'),'files':rows}
def available():
 data=dict((line.split(':')[0],line.split(':')[1].strip()) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())
 return int(data['MemAvailable'].split()[0])
def rss_for_group(pgrp):
 total=0
 for p in pathlib.Path('/proc').iterdir():
  if not p.name.isdigit(): continue
  try:
   if os.getpgid(int(p.name)) != pgrp: continue
   status=(p/'status').read_text()
   line=next((s for s in status.splitlines() if s.startswith('VmRSS:')),None)
   if line: total+=int(line.split()[1])
  except (OSError,ProcessLookupError): pass
 return total
before=manifest()
(out/'before.json').write_text(json.dumps(before,indent=2)+'\n')
assert before['tree']==before['published_tree'], 'source tree differs from published identity'
env=os.environ.copy()
env.update({'GOMAXPROCS':'2','GOMEMLIMIT':'2GiB'})
cmd=['bun','run','check:types']
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
start=time.monotonic()
peak_group=0
min_available=available()
stop_reason=None
log=(out/'full-typecheck.log').open('w')
log.write('$ GOMAXPROCS=2 GOMEMLIMIT=2GiB bun run check:types\n')
log.flush()
p=subprocess.Popen(cmd,cwd=repo/'packages/coding-agent',env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
print(f'{label} full gate started pid={p.pid}, receipt={out}',flush=True)
with (out/'resources.jsonl').open('w') as samples:
 while True:
  pid,status,usage=os.wait4(p.pid,os.WNOHANG)
  elapsed=time.monotonic()-start
  av=available(); rss=rss_for_group(p.pid)
  peak_group=max(peak_group,rss); min_available=min(min_available,av)
  samples.write(json.dumps({'elapsed_seconds':round(elapsed,3),'available_kib':av,'process_group_rss_kib':rss})+'\n');samples.flush()
  if pid:
   code=os.waitstatus_to_exitcode(status)
   break
  if elapsed>240 or av<600*1024:
   stop_reason='timeout_240s' if elapsed>240 else 'host_availability_under_600MiB'
   os.killpg(p.pid,signal.SIGTERM)
   time.sleep(1)
   try: os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError: pass
   pid,status,usage=os.wait4(p.pid,0)
   code=os.waitstatus_to_exitcode(status)
   break
  time.sleep(.5)
p.returncode=code
elapsed=time.monotonic()-start
log.close()
after=manifest()
(out/'after.json').write_text(json.dumps(after,indent=2)+'\n')
res={'label':label,'started_at':started,'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'cwd':str(repo/'packages/coding-agent'),'command':cmd,'script':'tsgo -p tsconfig.json --noEmit','resource_env':{'GOMAXPROCS':'2','GOMEMLIMIT':'2GiB'},'timeout_seconds':240,'initial_available_kib':min_available if not (out/'resources.jsonl').exists() else json.loads((out/'resources.jsonl').read_text().splitlines()[0])['available_kib'],'minimum_available_kib':min_available,'peak_sampled_process_group_rss_kib':peak_group,'wait4_max_child_rss_kib':usage.ru_maxrss,'elapsed_seconds':elapsed,'exit_code':code,'shell_equivalent_exit_code':128-code if code<0 else code,'stop_reason':stop_reason,'source_and_ownership_unchanged':before==after,'published_identity':pub,'verified_source_tree':before['tree']}
(out/'result.json').write_text(json.dumps(res,indent=2)+'\n')
print(json.dumps(res,indent=2),flush=True)
print((out/'full-typecheck.log').read_text(),flush=True)
sys.exit(code if code >= 0 else 128 - code)
