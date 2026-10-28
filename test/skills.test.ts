/**
 * The agent skills in skills/: Agent Skills frontmatter, one description that
 * says when to use them, and an index that lists every skill. The Skills CLI
 * (`npx skills add ridhotamma/bunwrite`) discovers this layout.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', 'skills')
const names = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('agent skills', () => {
  test('every skill has valid Agent Skills frontmatter', () => {
    expect(names).toEqual(['bunwrite', 'bunwrite-cli', 'bunwrite-functions', 'bunwrite-sites'])
    for (const name of names) {
      const text = read(join(name, 'SKILL.md'))
      expect(text.startsWith('---\n')).toBe(true)
      const end = text.indexOf('\n---', 4)
      expect(end).toBeGreaterThan(4)
      const frontmatter = text.slice(4, end)
      expect(frontmatter).toContain(`name: ${name}`)
      const description = frontmatter.match(/^description: "(.+)"$/m)?.[1] ?? ''
      expect(description.length).toBeGreaterThan(40)
      expect(description.length).toBeLessThan(1024)
      expect(description).toContain('Triggers:')
    }
  })

  test('the index lists every skill and the npx install command', () => {
    const readme = read('README.md')
    expect(readme).toContain('npx skills add ridhotamma/bunwrite')
    for (const name of names) expect(readme).toContain(`](${name}/SKILL.md)`)
  })

  test('skills do not use repository-relative links that break when installed', () => {
    for (const name of names) {
      const text = read(join(name, 'SKILL.md'))
      expect(text).not.toMatch(/\]\((\.\.\/)+/)
    }
  })
})
