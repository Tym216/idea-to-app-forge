import { fingerprint, sourceError } from './managed-source.js';
import { coreHealthVerified, reclassifyStoredVerification } from './verify.js';
const contract = items => items.map(({id,action,expect,external,severity,steps}) =>
 ({id,action,expect,external:external===true,severity:severity||'detail',steps:steps||[]}));
/** Only a user-requested resume of an automation-only validation stop avoids ReAct. */
export function verificationContinuationCandidate(task, workspace) {
 const previous=workspace?.state?.verify;
 if(task.mode!=='build'||task.operation!=='agent'||task.kind!=='resume'||previous?.status!=='blocker'
   ||!coreHealthVerified(previous.result?.base)) return false;
 const result=reclassifyStoredVerification(previous.result,previous.result.items);
 return result?.kind==='success_with_warnings'&&result.items.some(i=>i.code==='AUTOMATION_INCONCLUSIVE');
}
export function assertVerificationContinuationBasis(task, workspace, plan, acceptance, buildBasis) {
 const state=workspace.state,previous=state.verify;
 if(plan.id!==task.plan_id||plan.version!==task.plan_version||plan.status!=='approved'
   ||state.state!=='confirmed'||state.writer||previous.workspace_revision!==state.revision
   ||previous.code_hash!==workspace.manifest.code_hash||!workspace.valid('build',buildBasis)
   ||state.build.status!=='passed'
   ||fingerprint(contract(previous.result.items))!==fingerprint(contract(acceptance)))
  throw sourceError('WORKSPACE_EVIDENCE_STALE','固定验收续接的源码、构建或批准依据已变化；未调用模型或修改代码');
}