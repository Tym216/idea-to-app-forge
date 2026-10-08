import {operationalConnect,operationalConfig} from './ops-db-target.mjs';
let db;
try{const c=await operationalConnect('restore');db=c.db;console.log(JSON.stringify({status:'PASS',project_ref:c.config.ref,tls_verified:true,read_only:(await db.query("select current_setting('transaction_read_only') v")).rows[0].v}));}
catch(e){
 const cfg=operationalConfig('restore'),u=new URL(cfg.databaseUrl);
 let m=String(e.message||'');for(const secret of [cfg.databaseUrl,u.password,decodeURIComponent(u.password)])if(secret)m=m.replaceAll(secret,'[REDACTED]');
 m=m.replace(/postgres(?:ql)?:\/\/\S+|eyJ[A-Za-z0-9_.-]+|sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g,'[REDACTED]').replace(/-----BEGIN[\s\S]+?-----END[^-]+-----/g,'[REDACTED]');
 console.log(JSON.stringify({status:'FAIL',project_ref:cfg.ref,error_type:typeof e.code==='string'?e.code:'CONNECTION_ERROR',server_reason_redacted:m.slice(0,180),endpoint_kind:/\.pooler\.supabase\.com$/.test(u.hostname)?'pooler':'direct',port:u.port||'5432',username_shape:decodeURIComponent(u.username)==='postgres.zynvesyeqsoeqssgwubj'?'postgres.<restore-ref>':decodeURIComponent(u.username)==='postgres'?'postgres':'other',TLS_verification_enabled:true,CA_path:cfg.caPath}));process.exitCode=1;
}finally{if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}}
