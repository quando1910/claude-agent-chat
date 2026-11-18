export type AgentDef = { name: string; model: string; effort: string; description: string; scope: 'project' | 'user' }

declare module 'claude-code' {
  interface PluginState {
    'agent-chat': {
      agents: AgentDef[]
      agent: string
      isOpen: boolean
    }
  }
}
