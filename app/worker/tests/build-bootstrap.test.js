import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildBootstrapChanges} from '../src/build-bootstrap.js';
import {SCAFFOLD_FILES} from '../src/scaffold.js';
import {sourceManifest,applySourceChanges} from '../src/managed-source.js';
import {renderPersistenceHelper,PERSISTENCE_HOOK_SOURCE} from '../src/app-persistence.js';
import {DESIGN_TOKENS_PATH,renderDesignTokensCss} from '../src/design.js';
const design={colors:{primary:'#123456'},spacing:[4,8],typography:{fontFamily:'system-ui',scale:{body:'16px'}},breakpoints:{mobile:640,desktop:1024}};
const options={environmentId:'atoms-demo',projectId:'project-a',design};
test('empty workspace bootstrap is one complete canonical target with scaffold, persistence and design',()=>{
 const changes=buildBootstrapChanges([],options);
 assert.equal(changes.length,Object.keys(SCAFFOLD_FILES).length+3);
 assert.equal(new Set(changes.map(c=>c.path)).size,changes.length);
 const actual=applySourceChanges(sourceManifest([]),changes);
 const expected=sourceManifest([...Object.entries(SCAFFOLD_FILES).map(([path,content])=>({path,content})),
  {path:'src/forge-persistence.ts',content:renderPersistenceHelper(options.environmentId,options.projectId)},
  {path:'src/forge-use-app-state.ts',content:PERSISTENCE_HOOK_SOURCE},
  {path:DESIGN_TOKENS_PATH,content:renderDesignTokensCss(design)}]);
 assert.equal(actual.code_hash,expected.code_hash);
});
test('existing source/package/helpers and preserved user design are not replaced; repeated bootstrap is a no-op',()=>{
 const baseline=applySourceChanges(sourceManifest([]),buildBootstrapChanges([],options));
 const custom=applySourceChanges(baseline,[{operation:'write',path:'src/App.tsx',content:'user application'},
 {operation:'write',path:'package.json',content:'custom dependencies'},{operation:'write',path:'src/forge-persistence.ts',content:'existing stable namespace'},
 {operation:'write',path:DESIGN_TOKENS_PATH,content:'user styling'}]);
 assert.deepEqual(buildBootstrapChanges(custom.files,{...options,preserveDesign:true}),[]);
 const changes=buildBootstrapChanges(custom.files,options);
 assert.deepEqual(changes.map(c=>c.path),[DESIGN_TOKENS_PATH]);
 assert.equal(applySourceChanges(custom,changes).files.find(f=>f.path==='src/forge-persistence.ts').content,'existing stable namespace');
 assert.deepEqual(buildBootstrapChanges(baseline.files,options),[]);
});
test('partial existing workspace only gains missing files; scaffold-only helper remains compatible',()=>{
 const files=[{path:'src/App.tsx',content:'keep me'},{path:'src/forge-use-app-state.ts',content:'keep helper'}];
 const changes=buildBootstrapChanges(files,options);assert.ok(!changes.some(c=>files.some(f=>f.path===c.path)));
 assert.equal(buildBootstrapChanges(files).length,Object.keys(SCAFFOLD_FILES).length-1);
 assert.throws(()=>buildBootstrapChanges(files,{environmentId:'atoms-demo'}),/explicit environment/);
});
