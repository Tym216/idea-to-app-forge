import { sourceError } from './managed-source.js';
/** Only immutable submission input supplies the regression basis; result is execution output. */
export function userApplyBasis(change) {
  const basis = change.submission_basis;
  if (!basis || !['checkpoint_id', 'basis_id', 'build_basis', 'verify_basis'].every(key => typeof basis[key] === 'string' && basis[key]))
    throw sourceError('WORKSPACE_BASIS_INVALID', 'User Apply immutable submission basis is missing');
  return basis;
}
/** Check captured execution basis before materialization can update task.context revision. */
export function assertUserApplyExecution(task, change, state) {
  if (task.operation !== 'user_apply' || change?.id !== task.requested_changeset_id || change.actor !== 'user'
    || change.origin !== 'user_apply' || change.task_id !== task.id || change.project_id !== task.project_id || change.user_id !== task.user_id
    || !change.submission_fingerprint) throw sourceError('WORKSPACE_REQUEST_INVALID', 'User Apply immutable submission identity mismatch');
  const revision = change.status === 'committed' ? task.context_workspace_revision : change.base_revision;
  if (revision !== state.revision || (change.status !== 'committed' && change.base_hash !== state.code_hash))
    throw sourceError('WORKSPACE_REVISION_CONFLICT', 'Workspace changed. Reload and reapply your edit.');
  if (state.writer && state.writer.task_id !== task.id) throw sourceError('WORKSPACE_RECONCILE_REQUIRED', 'Another execution still owns a source side effect');
}
export async function executeUserApply({ task, workspace, loadChange, validateBasis, validateAndComplete, onApply = async () => {} }) {
  let change = await loadChange();
  await workspace.read();
  assertUserApplyExecution(task, change, workspace.state);
  const basis = await validateBasis(change); // no model; fixed checkpoint inputs
  if (change.status !== 'committed') { await workspace.applyRequested(change); await onApply(change); }
  change = await loadChange();
  if (change.status !== 'committed') throw sourceError('WORKSPACE_UNCERTAIN', 'Requested mutation not confirmed');
  return validateAndComplete(basis);
}
