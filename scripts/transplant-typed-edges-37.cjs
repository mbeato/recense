const D=require(__dirname+'/../node_modules/better-sqlite3');
const PRED=["built_by","works_on","part_of","uses","depends_on","runs_on","located_in","integrates_with","supersedes","prefers","evaluated","configured_with"];
const ph=PRED.map(()=>'?').join(',');
const scratch=new D('/tmp/scratch-live-37.db',{readonly:true});
const live=new D(process.env.HOME+'/.config/recense/recense.db');
const edges=scratch.prepare(`SELECT src,dst,rel,w FROM edge WHERE kind='relation' AND rel IN (${ph})`).all(...PRED);
const liveHas=live.prepare('SELECT 1 FROM node WHERE id=?');
const ins=live.prepare("INSERT OR IGNORE INTO edge (src,dst,rel,w,last_access,kind) VALUES (?,?,?,?,?,'relation')");
const now=Date.now();
let inserted=0,skippedFK=0;
const tx=live.transaction(()=>{
  for(const e of edges){
    if(!liveHas.get(e.src)||!liveHas.get(e.dst)){skippedFK++;continue;}
    const r=ins.run(e.src,e.dst,e.rel,e.w??0.1,now);
    inserted+=r.changes;
  }
});
tx();
console.log('inserted:',inserted,'| skipped(FK):',skippedFK,'| source edges:',edges.length);
const fk=live.prepare('PRAGMA foreign_key_check').all();
console.log('foreign_key_check:',fk.length===0?'CLEAN':JSON.stringify(fk.slice(0,5)));
const got=live.prepare(`SELECT COUNT(*) c FROM edge WHERE kind='relation' AND rel IN (${ph})`).get(...PRED);
console.log('typed-predicate edges now in LIVE:',got.c);
live.close();
