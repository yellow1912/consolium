type ExecResult = { exitCode: number; stdout: string }
export type ExecFn = (cmd: string[]) => Promise<ExecResult>

async function defaultExec(cmd: string[]): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return { exitCode: proc.exitCode ?? 0, stdout }
}

export class TmuxManager {
  private exec: ExecFn

  constructor(execFn?: ExecFn) {
    this.exec = execFn ?? defaultExec
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await this.exec(["tmux", "-V"])
      return r.exitCode === 0
    } catch {
      return false
    }
  }

  async findPaneForPid(pid: number): Promise<string | null> {
    let r: ExecResult
    try {
      r = await this.exec([
        "tmux", "list-panes", "-a", "-F",
        "#{pane_pid}|#{session_name}:#{window_index}.#{pane_index}",
      ])
    } catch {
      return null
    }
    if (r.exitCode !== 0) return null

    const lines = r.stdout.trim().split("\n").filter(Boolean)
    for (const line of lines) {
      const sep = line.indexOf("|")
      if (sep === -1) continue
      const panePid = parseInt(line.slice(0, sep), 10)
      const target = line.slice(sep + 1)
      if (isNaN(panePid) || !target) continue
      if (await this.isDescendant(pid, panePid)) return target
    }
    return null
  }

  private async isDescendant(target: number, root: number): Promise<boolean> {
    const visited = new Set<number>()
    const queue: number[] = [root]
    while (queue.length > 0) {
      const current = queue.shift()!
      if (visited.has(current)) continue
      visited.add(current)
      if (current === target) return true
      const children = await this.pgrepChildren(current)
      queue.push(...children)
    }
    return false
  }

  private async pgrepChildren(pid: number): Promise<number[]> {
    try {
      const r = await this.exec(["pgrep", "-P", String(pid)])
      return r.stdout.trim().split("\n").map(s => parseInt(s, 10)).filter(n => !isNaN(n))
    } catch {
      return []
    }
  }
}
