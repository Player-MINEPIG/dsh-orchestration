import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { identifier, insist } from './protocol.js'
import type { Claim, ExecutionProvider, WorkerPolicy } from './ports.js'

export async function authorizedWorkspace(claim: Claim, policy: WorkerPolicy, provider: ExecutionProvider): Promise<string> {
  insist(policy.role === 'executor' || policy.role === 'both', 'EXECUTOR_ROLE_REQUIRED', 403)
  insist(identifier(policy.nodeId) && claim.attempt.nodeId === policy.nodeId && claim.run.route?.nodeId === policy.nodeId, 'WRONG_EXECUTOR', 403)
  insist(claim.attempt.taskId === claim.task.taskId && claim.attempt.runId === claim.run.runId && claim.run.taskId === claim.task.taskId, 'CLAIM_IDENTITY_MISMATCH', 403)
  const route = claim.run.route
  const taskPolicy = claim.task.policy
  insist(!taskPolicy?.allowedNodeIds || taskPolicy.allowedNodeIds.includes(policy.nodeId),'TASK_NODE_DENIED',403)
  insist(!taskPolicy?.allowedWorkspaceIds || (route.workspaceId && taskPolicy.allowedWorkspaceIds.includes(route.workspaceId)),'TASK_WORKSPACE_DENIED',403)
  if (taskPolicy?.maxRuntimeMs !== undefined) insist(Number.isSafeInteger(taskPolicy.maxRuntimeMs) && taskPolicy.maxRuntimeMs >= 100 && taskPolicy.maxRuntimeMs <= 86400000,'INVALID_RUNTIME_BUDGET')
  insist(route.requiredCapabilities.every(cap => policy.capabilities.includes(cap) && provider.capabilities.includes(cap)), 'CAPABILITY_DENIED', 403)
  // The execution backend may support several explicitly configured LLM vendors.
  // supports must enforce the exact provider/model/effort tuple; id is diagnostic.
  insist(provider.supports(route), 'PROVIDER_ROUTE_DENIED', 403)
  insist(route.workspaceId && (!claim.task.workspaceId || claim.task.workspaceId === route.workspaceId), 'WORKSPACE_IDENTITY_MISMATCH', 403)
  const binding = policy.workspaces.find(w => w.workspaceId === route.workspaceId && w.nodeId === policy.nodeId)
  insist(binding && isAbsolute(binding.path) && isAbsolute(binding.allowedRoot), 'WORKSPACE_DENIED', 403)
  const [path, root] = await Promise.all([realpath(binding.path), realpath(binding.allowedRoot)])
  const local = relative(root,path)
  insist(local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local), 'WORKSPACE_ESCAPE', 403)
  insist((await stat(path)).isDirectory(), 'WORKSPACE_NOT_DIRECTORY')
  return path
}
