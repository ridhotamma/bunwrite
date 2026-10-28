/**
 * `bunwrite skills` and `bunwrite init skill`: install Bunwrite's agent skills
 * with the Skills CLI (`npx skills add ridhotamma/bunwrite`), so Claude Code,
 * Cursor, Codex, OpenCode and other agents get instructions that match this
 * server.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { bool, flagList, type Args } from '../args'
import { CliError, closeAsk, confirm, info, log, success, warn } from '../ui'

/** The GitHub repository holding `skills/`. */
export const SKILLS_SOURCE = 'ridhotamma/bunwrite'

/** Where the Skills CLI and Appwrite's CLI put project skills. */
const SKILL_DIRS = ['.agents/skills', '.claude/skills']

/** The options `npx skills add` understands, in the order the user gave them. */
function forwarded(args: Args): string[] {
  const out: string[] = []
  for (const skill of flagList(args, 'skill')) out.push('--skill', skill)
  for (const agent of flagList(args, 'agent')) out.push('--agent', agent)
  if (bool(args, 'global')) out.push('--global')
  if (bool(args, 'copy')) out.push('--copy')
  if (bool(args, 'yes')) out.push('--yes')
  if (bool(args, 'all')) out.push('--all')
  if (bool(args, 'list')) out.push('--list')
  return out
}

/** The `npx skills add ...` command this run would execute. */
export function skillsCommand(args: Args): string {
  return ['npx', '-y', 'skills', 'add', SKILLS_SOURCE, ...forwarded(args)].join(' ')
}

/** True when this project already has a Bunwrite skill from a previous install. */
export function hasBunwriteSkill(dir = process.cwd()): boolean {
  return SKILL_DIRS.some((relative) => {
    const path = join(dir, relative)
    if (!existsSync(path)) return false
    try {
      return readdirSync(path).some((name) => name === 'bunwrite' || name.startsWith('bunwrite-'))
    } catch {
      return false
    }
  })
}

/** Run the Skills CLI, falling back to `bunx` when `npx` is not on PATH. */
function runSkills(args: Args): void {
  closeAsk()
  const command = forwarded(args)
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const bunx = process.platform === 'win32' ? 'bunx.cmd' : 'bunx'
  const spawn = (bin: string, prefix: string[]) =>
    spawnSync(bin, [...prefix, 'skills', 'add', SKILLS_SOURCE, ...command], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })

  let result = spawn(npx, ['-y'])
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') result = spawn(bunx, [])
  if (result.error) {
    throw new CliError(`Could not run the Skills CLI: ${result.error.message}. Install the skills yourself with \`npx skills add ${SKILLS_SOURCE}\`.`)
  }
  if (result.status !== 0) {
    throw new CliError(`The Skills CLI exited with code ${result.status ?? 'unknown'}. Run it yourself with \`npx skills add ${SKILLS_SOURCE}\`.`)
  }
}

/** `bunwrite skills` and `bunwrite init skill`. */
export async function skills(args: Args): Promise<void> {
  if (bool(args, 'print')) {
    log(skillsCommand(args))
    return
  }
  runSkills(args)
  if (!bool(args, 'list')) success('Bunwrite agent skills installed')
}

/**
 * After `init project`, offer the skills unless the folder already has them.
 * Never fails the linking: a missing `npx`, no network or a user who declines
 * only produces a hint.
 */
export async function offerSkills(args: Args): Promise<void> {
  const requested = args.flags.has('skills') ? bool(args, 'skills') : undefined
  if (requested === false) return
  if (hasBunwriteSkill()) {
    info('Bunwrite agent skills are already installed in this project')
    return
  }

  const hint = `Install Bunwrite agent skills with \`npx skills add ${SKILLS_SOURCE}\` (or \`bunwrite skills\`).`
  if (requested !== true) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      info(hint)
      return
    }
    if (!(await confirm('Install Bunwrite agent skills for your AI coding agent?', true))) {
      info(hint)
      return
    }
  }

  try {
    if (bool(args, 'print')) {
      log(skillsCommand(args))
      return
    }
    runSkills(args)
    success('Bunwrite agent skills installed')
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error))
  }
}
