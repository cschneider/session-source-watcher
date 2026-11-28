// SPDX-License-Identifier: Apache-2.0
// The subset of the Copilot extension SDK this adapter uses. The CLI resolves
// the module at runtime; it is not an npm dependency.
declare module "@github/copilot-sdk/extension" {
  export interface ToolInvocation {
    sessionId: string;
    toolCallId: string;
    toolName: string;
  }
  export interface ToolResultObject {
    textResultForLlm: string;
    resultType: "success" | "failure" | "rejected" | "denied" | "timeout";
  }
  export interface Tool {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    handler?: (args: unknown, invocation: ToolInvocation) => Promise<string | ToolResultObject> | string | ToolResultObject;
    skipPermission?: boolean;
  }
  export interface BaseHookInput {
    sessionId: string;
    timestamp: Date;
    workingDirectory: string;
  }
  export interface SessionHooks {
    onSessionStart?: (input: BaseHookInput & { source: "startup" | "resume" | "new" }) => Promise<{ additionalContext?: string } | void>;
    onPostToolUse?: (input: BaseHookInput & { toolName: string; toolArgs: unknown; toolResult: ToolResultObject }) => Promise<void> | void;
    onAgentStop?: (input: BaseHookInput & { stopReason?: string }) => Promise<void> | void;
    onSessionEnd?: (input: BaseHookInput & { reason: string }) => Promise<void> | void;
  }
  export interface SessionEvent {
    type: string;
    agentId?: string;
    data?: Record<string, unknown>;
  }
  export interface MessageOptions {
    prompt: string;
    displayPrompt?: string;
    mode?: "enqueue" | "immediate";
    source?: string;
    clientTurnId?: string;
  }
  export interface JoinedSession {
    readonly sessionId: string;
    readonly workspacePath?: string;
    send(options: MessageOptions): Promise<string>;
    getEvents(): Promise<SessionEvent[]>;
    on(handler: (event: SessionEvent) => void): () => void;
    log(message: string, options?: { level?: "info" | "warning" | "error"; ephemeral?: boolean }): Promise<void>;
  }
  export interface CanvasContext {
    instanceId: string;
    input?: unknown;
  }
  export interface CanvasOptions {
    id: string;
    displayName: string;
    description: string;
    open: (ctx: CanvasContext) => Promise<{ url?: string; title?: string; status?: string }>;
    onClose?: (ctx: CanvasContext) => Promise<void> | void;
    actions?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; handler: (ctx: CanvasContext) => unknown }>;
  }
  export type Canvas = { readonly declaration: { id: string } };
  export function createCanvas(options: CanvasOptions): Canvas;
  export function joinSession(config?: {
    tools?: { definitions?: Tool[] };
    hooks?: SessionHooks;
    canvases?: { definitions?: Canvas[] };
  }): Promise<JoinedSession>;
}
