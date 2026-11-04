export declare const WORKSPACE: Readonly<{
    version: 1;
    frameBytes: 65536;
    chunkBytes: 32768;
    fileBytes: 1048576;
    jsonBytes: 262144;
    window: 4;
    viewerPending: 2;
    accountPending: 8;
    topicPending: 32;
    totalMs: 30000;
    progressMs: 5000;
    pathBytes: 4096;
    lines: 20000;
    lineScalars: 20000;
    startsPerMinute: 60;
    acksPerMinute: 2048;
    hostControlsPerMinute: 240;
    bytesPerMinute: number;
    byteBurst: number;
}>;
export type WorkspaceOp = "list" | "read" | "changes" | "diff";
export interface WorkspaceRequest {
    connectionId: string;
    connectionToken: string;
    epoch: string;
    requestId: string;
    op: WorkspaceOp;
    path?: string;
    repo?: string;
    cursor?: string | null;
}
export declare const wireBytes: (value: string) => number;
export declare const isWorkspaceId: (value: unknown) => value is string;
export declare const isObject: (value: unknown) => value is Record<string, unknown>;
export declare class WorkspaceError extends Error {
    readonly code: string;
    readonly details?: Record<string, number>;
    constructor(code: string, details?: Record<string, number>);
}
export declare function relativeWorkspacePath(value: unknown, root?: boolean): value is string;
export declare function workspaceRequest(value: unknown): WorkspaceRequest;
export declare const WORKSPACE_ERRORS: Set<string>;
export declare function safeWorkspaceDetails(value: unknown): Record<string, number> | undefined;
export interface StreamCount {
    name: string;
    exists: boolean;
    bytes: number;
    received: number;
    chunks: number;
}
export interface StreamState {
    streams: StreamCount[];
    seq: number;
    ack: number;
    index: number;
}
export declare function beginWorkspace(op: WorkspaceOp, value: unknown): StreamState;
export declare function base64Bytes(data: unknown): number;
export declare function chunkWorkspace(s: StreamState, frame: Record<string, unknown>): number;
export declare function ackWorkspace(s: StreamState, seq: unknown): boolean;
export declare function endWorkspace(s: StreamState, value: unknown): void;
export declare function workspaceCapacity(pending: {
    account: string;
    viewer: string;
}[], account: string, viewer: string): boolean;

export declare const WORKSPACE_OPS: readonly WorkspaceOp[];
export interface WorkspaceHostRequest extends Pick<WorkspaceRequest, "op" | "path" | "repo" | "cursor" | "requestId" | "epoch"> { type: "workspace_request"; v: 1; topicId: string; computerId: string; owner: string; viewerId: string; transferId: string; timeoutMs: number }
export declare function workspaceHostRequest(value: unknown): WorkspaceHostRequest;

export declare function validateWorkspaceText(bytes: Uint8Array): { bom: boolean; eol: string };
