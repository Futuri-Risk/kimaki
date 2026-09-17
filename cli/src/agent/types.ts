import type { ModelSelection, RpcId } from './native/types.js';
export type { RpcId, ModelSelection, NativeSnapshot, InteractionAnswer, ForkPoint } from './native/types.js';
export type BackendId = 'opencode' | 'zcode';
export type WorkspaceBinding = {
    projectDirectory: string;
    canonicalDirectory: string;
    nativeWorkspacePath: string;
    nativeWorkspaceKey: string;
    ownerMachineId: string;
    nativeHomeIdentity: string;
};
export type AgentSession = {
    id: string;
    backend: BackendId;
    nativeSessionId: string | null;
    workspace: WorkspaceBinding;
    profileId: string;
    profileRevision: string;
    controllerThreadId: string;
    state: string;
    model: ModelSelection;
};
export type OperationKind = 'prompt' | 'guide' | 'answer' | 'cancel' | 'compact' | 'model' | 'fork';
export type OperationState = 'queued' | 'preparing' | 'send-intent' | 'submission-unknown' | 'running' | 'waiting-interaction' | 'foreground-terminal' | 'completed' | 'failed' | 'cancelled' | 'rejected' | 'cancel-unconfirmed';
export type Input = {
    sessionId: string;
    threadId: string;
    actorId: string;
    source: 'discord' | 'schedule' | 'cli';
    sourceId: string;
    kind: OperationKind;
    text: string;
    originalText?: string;
    payload?: unknown;
};
export type Operation = {
    model: ModelSelection;
    id: string;
    sessionId: string;
    threadId: string;
    actorId: string;
    source: Input['source'];
    sourceId: string;
    kind: OperationKind;
    state: OperationState;
    text: string;
    payload: unknown;
    originalHash: string;
    normalizedHash: string;
    order: number;
    nativeTurnId: string | null;
    generation: string | null;
};
export type DisplayPart = {
    id: string;
    nativeId: string;
    kind: 'text' | 'reasoning' | 'tool' | 'file-change' | 'notice';
    state: 'streaming' | 'running' | 'done' | 'error' | 'cancelled' | 'unknown';
    text: string;
    toolName?: string;
    delivery: 'live' | 'snapshot';
    order: number;
};
export type Cursor = {
    stream: 'legacy' | 'v4';
    generation: string;
    epoch: string;
    sequence: number;
    revision?: number;
};
export type NativeInteraction = {
    id: string;
    sessionId: string;
    generation: string;
    requestId: RpcId;
    kind: 'permission' | 'question' | 'plan-approval';
    schema: unknown;
    expiresAt: number;
    threadId: string;
};
export type NativeEvent = {
    type: 'turn-started';
    turnId: string;
} | {
    type: 'terminal';
    turnId: string;
    outcome: 'completed' | 'failed' | 'cancelled';
} | {
    type: 'parts';
    parts: readonly DisplayPart[];
    cursor: Cursor;
} | {
    type: 'guide-admitted' | 'guide-applied';
    commandId: string;
} | {
    type: 'activity';
} | {
    type: 'disconnected';
} | {
    type: 'interaction';
    request: NativeInteraction;
} | {
    type: 'interaction-closed';
    id: string;
} | {
    type: 'diagnostic';
    code: string;
};
