/** Native-only domain contracts; no host/session/SQL/UI dependencies. */
export type RpcId = string | number
export type ModelSelection = {
  providerId: string
  modelId: string
  reasoning?: string
  revision: string
}
export type NativeSnapshot = {
  sessionId: string
  workspacePath: string
  workspaceKey: string
  model: ModelSelection
  foreground: null | {
    id: string
    state: 'running' | 'waiting'
  }
  background: readonly string[]
  goalActive: boolean
  terminal: null | {
    turnId: string
    outcome: 'completed' | 'failed' | 'cancelled'
  }
}
export type InteractionAnswer =
  | {
      kind: 'permission'
      decision: 'allow-once' | 'deny'
    }
  | {
      kind: 'question'
      values: Readonly<Record<string, readonly string[]>>
    }
  | {
      kind: 'plan-approval'
      approved: boolean
    }
export type ForkPoint = {
  rowId: number
  entityId: string
  revision: number
  logEpoch: string
}
