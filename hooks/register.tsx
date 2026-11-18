import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentDef } from '../types'

const USAGE =
  'Usage: /agent-chat                      (shows the agent picker above the message box)\n' +
  '       /agent-chat [--mode <mode>] <agent> <request>\n' +
  'Example: /agent-chat finn Design the caching layer for the search API\n' +
  'Modes for the first turn: auto (default), acceptEdits, plan, default, bypassPermissions'

const MODES = ['auto', 'acceptEdits', 'plan', 'default', 'bypassPermissions']

const agents = atom({ plugin: 'agent-chat', key: 'agents' } as const, [] as AgentDef[])
const chosen = atom({ plugin: 'agent-chat', key: 'agent' } as const, '')
const isOpen = atom({ plugin: 'agent-chat', key: 'isOpen' } as const, false)

// Runs detached (nohup ... &), so the new session outlives this one and any
// reload of this mod. Values arrive as positional parameters, never spliced
// into the script text: $1 agent, $2 session id, $3 mode, $4 title, $5 request.
const LAUNCH = `
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
dir="$HOME/.claude/agent-chat"
mkdir -p "$dir"
nohup /bin/sh -c '
  printf "%s" "$5" | claude -p --agent "$1" --session-id "$2" --permission-mode "$3" -n "$4" &&
  script -q /dev/null claude --resume "$2" --desktop </dev/null
' agent-chat "$1" "$2" "$3" "$4" "$5" >"$dir/$2.log" 2>&1 &
`

// Prints one tab-separated line per agent file: scope, name, model, effort, description.
// Project agents come first and win over a user agent of the same name.
const LIST_AGENTS = `
for scope in project user; do
  if [ $scope = project ]; then d="$PWD/.claude/agents"; else d="$HOME/.claude/agents"; fi
  for f in "$d"/*.md; do
    [ -f "$f" ] || continue
    awk -v scope=$scope -v file="$(basename "$f" .md)" '
      NR==1 && $0!="---" { exit }
      NR>1 && $0=="---" { exit }
      /^name:/ { sub(/^name:[ \\t]*/, ""); name=$0 }
      /^model:/ { sub(/^model:[ \\t]*/, ""); model=$0 }
      /^effort:/ { sub(/^effort:[ \\t]*/, ""); effort=$0 }
      /^description:/ { sub(/^description:[ \\t]*/, ""); desc=$0 }
      END { if (name=="") name=file; if (model=="") model="inherit"; if (effort=="") effort="default"; printf "%s\\t%s\\t%s\\t%s\\t%s\\n", scope, name, model, effort, desc }
    ' "$f"
  done
done
`

type Run = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

async function loadAgents(run: Run): Promise<AgentDef[]> {
  const out = await run(['/bin/sh', '-c', LIST_AGENTS])
  const seen = new Set<string>()
  const list: AgentDef[] = []
  for (const line of out.stdout.split('\n')) {
    const [scope, name, model, effort, description = ''] = line.split('\t')
    if (!name || seen.has(name)) continue
    seen.add(name)
    list.push({ scope: scope === 'project' ? 'project' : 'user', name, model: model ?? 'inherit', effort: effort ?? 'default', description })
  }
  return list
}

const display = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

async function start(run: Run, agent: string, permissionMode: string, request: string): Promise<string> {
  const uuid = await run(['/usr/bin/uuidgen'])
  const id = uuid.stdout.trim().toLowerCase()
  if (uuid.exitCode !== 0 || !id) throw new Error('Could not create a session id (uuidgen failed).')

  const title = `${display(agent)}: ${request.replace(/\s+/g, ' ').slice(0, 50)}`
  const launched = await run(['/bin/sh', '-c', LAUNCH, 'agent-chat', agent, id, permissionMode, title, request])
  if (launched.exitCode !== 0) throw new Error(`Could not start ${display(agent)}: ${launched.stderr.trim()}`)

  return id
}

const startedText = (agent: string, id: string) =>
  `Sent to ${display(agent)}. The new session opens in the Desktop app after ${display(agent)}'s first reply. ` +
  `Log: ~/.claude/agent-chat/${id}.log`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-chat',
      description: 'Start a new desktop session with a custom agent as the main agent (no args: agent picker)',
    })

    return next(e)
  })

  on('command.run', { command: 'agent-chat' }, async ($, e) => {
    const run: Run = argv => $.process.run(argv)
    let rest = e.args.trim()

    if (rest === '') {
      const list = await loadAgents(run)
      if (list.length === 0) return { text: 'No agents found in .claude/agents or ~/.claude/agents.' }
      await update($, agents, () => list)
      const current = await read($, chosen)
      if (!list.some(a => a.name === current)) await update($, chosen, () => list[0]!.name)
      await update($, isOpen, () => true)
      return { text: 'Agent picker is above the message box: pick an agent, then type your request and press Enter.' }
    }

    let permissionMode = 'auto'
    const modeMatch = /^--mode\s+(\S+)\s+/.exec(rest)
    if (modeMatch) {
      permissionMode = modeMatch[1]!
      rest = rest.slice(modeMatch[0].length)
    }
    const m = /^(\S+)\s+([\s\S]+)$/.exec(rest)
    if (!m) return { text: USAGE }
    if (!MODES.includes(permissionMode)) return { text: `Unknown mode "${permissionMode}".\n${USAGE}` }

    const agent = m[1]!
    const request = m[2]!.trim()
    const list = await loadAgents(run)
    if (!list.some(a => a.name === agent)) {
      return { text: `No agent "${agent}" found. Available: ${list.map(a => a.name).join(', ') || 'none'}` }
    }

    try {
      const id = await start(run, agent, permissionMode, request)
      $.ui.toast(`${display(agent)} is working on it`)
      return { text: startedText(agent, id) }
    } catch (err) {
      return { text: String((err as Error).message ?? err) }
    }
  })

  // While the picker is open, a message typed in the main box goes to the
  // chosen agent's new session instead of this one.
  on('prompt.submit', async ($, e, next) => {
    const isOwnMessage = e.origin.kind === 'composer' && !e.command && !e.isMeta
    if (!isOwnMessage || !(await read($, isOpen))) return next(e)

    const request = e.text.trim()
    if (!request) return next(e)
    if (e.attachments?.length) return { drop: 'agent-chat: images and files cannot be sent to a new agent session; send text only.' }

    const agent = await read($, chosen)
    try {
      const id = await start(argv => $.process.run(argv), agent, 'auto', request)
      await update($, isOpen, () => false)
      $.ui.toast(`${display(agent)} is working on it`)
      void id
      return { drop: `→ Sent to ${display(agent)} · opens in Desktop after its first reply` }
    } catch (err) {
      return { drop: `agent-chat: ${String((err as Error).message ?? err)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await read($, isOpen))) return next(e)

    const { Box, Text, Select, Button } = $.ui.resolve(e)
    const list = await read($, agents)
    const agent = await read($, chosen)
    const picked = list.find(a => a.name === agent)

    return (
      <Box flexDirection="column">
        <Box gap={1} alignItems="center">
          <Text>Send to</Text>
          <Select
            key="agent"
            value={agent}
            options={list.map(a => ({ value: a.name, label: display(a.name) }))}
            onSelect={value => update($, chosen, () => value)}
          />
          <Text dimColor>Type your request below and press Enter</Text>
          <Button key="close" label="✕" plain role="dismiss" onPress={() => update($, isOpen, () => false)} />
        </Box>
        {picked ? <Text dimColor>Model: {picked.model} · Effort: {picked.effort}</Text> : null}
        {picked?.description ? <Text dimColor wrap="truncate-end">{picked.description}</Text> : null}
      </Box>
    )
  })
}
