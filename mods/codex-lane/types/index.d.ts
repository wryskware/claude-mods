export type JobView = {
  id: string
  description: string
  effort: string
  cwd: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'failed' | 'cancelled'
}

export type DispatchInput = {
  brief: string
  description: string
  effort: string
  cwd?: string
  model?: string
  worktree?: boolean
}

export type AgentRow = { id: string; description: string; type: string; status: string }

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__codex-lane__dispatch': DispatchInput
    'mcp__codex-lane__result': { id: string }
    'mcp__codex-lane__cancel': { id: string }
  }
  interface PluginState {
    'codex-lane': { jobs: JobView[]; agents: AgentRow[]; now: number }
  }
}
