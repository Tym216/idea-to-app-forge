-- Read-only catalog inspection for user review / SQL Editor. No freeze, migration or DML.
-- Run only on confirmed main ref vfzyimhapttcdxeabvur after approval to inspect metadata.
begin transaction read only;

select c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' and c.relname like 'ita_%'
order by c.relname;

select p.proname,pg_get_function_identity_arguments(p.oid) signature,p.prosecdef,p.proconfig,
 encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') definition_hash,
 has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') service_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname like 'ita_%' order by p.proname,signature;

select c.relname,t.tgname,t.tgenabled,
 encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex') definition_hash
from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname like 'ita_%' and not t.tgisinternal order by c.relname,t.tgname;

select c.relname,a.attname,a.atttypid::regtype data_type,a.attnotnull,a.attacl
from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname like 'ita_%' and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum;

select c.relname,k.conname,pg_get_constraintdef(k.oid) definition
from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname like 'ita_%' order by c.relname,k.conname;

select tablename,indexname,indexdef from pg_indexes where schemaname='public' and tablename like 'ita_%' order by tablename,indexname;
select tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename like 'ita_%' order by tablename,policyname;
select status,count(*) from public.ita_tasks group by status order by status;
select status,count(*) from public.ita_preview_recoveries group by status order by status;
select status,count(*) from public.ita_project_deletions group by status order by status;
select to_regclass('supabase_migrations.schema_migrations') as optional_migration_history;

rollback;
