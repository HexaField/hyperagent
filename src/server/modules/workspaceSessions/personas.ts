import fs from 'fs/promises'
import path from 'path'
import os from 'os'

export type PersonaSummary = {
  id: string
  label?: string
  description?: string
  model?: string
  mode?: string
  tools?: Record<string, unknown>
  permission?: Record<string, unknown>
  updatedAt: string
}

export type PersonaDetail = {
  id: string
  markdown: string
  frontmatter: Record<string, unknown>
  body: string
  updatedAt: string
}

const CONFIG_AGENT_DIR = path.join(os.homedir(), '.config', 'opencode', 'agent')

function sanitizeId(candidate: string): string {
  if (!candidate || typeof candidate !== 'string') candidate = `persona-${Date.now()}`
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || `persona-${Date.now()}`
}

async function ensureDir(): Promise<string> {
  await fs.mkdir(CONFIG_AGENT_DIR, { recursive: true })
  return CONFIG_AGENT_DIR
}

function personaPathFor(id: string): string {
  const name = sanitizeId(id) + '.md'
  const candidate = path.join(CONFIG_AGENT_DIR, name)
  const resolved = path.resolve(candidate)
  if (!resolved.startsWith(path.resolve(CONFIG_AGENT_DIR))) {
    throw new Error('Invalid persona id')
  }
  return resolved
}

export function parseFrontmatter(markdown: string): { fm: Record<string, unknown>; body: string } {
  const fmMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!fmMatch) return { fm: {}, body: markdown }
  const raw = fmMatch[1]
  const lines = raw.split(/\r?\n/)
  const fm: Record<string, unknown> = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // match a key: value or a key: (start of nested block)
    const m = line.match(/^([a-zA-Z0-9_\-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1].trim()
    const rest = m[2]
    if (rest === '' || rest === undefined) {
      // collect indented nested lines
      const nested: Record<string, unknown> = {}
      let j = i + 1
      for (; j < lines.length; j++) {
        const sub = lines[j]
        const sm = sub.match(/^\s+([a-zA-Z0-9_\-]+)\s*:\s*(.*)$/)
        if (!sm) break
        let sk = sm[1].trim()
        let sv: any = sm[2].trim()
        if (/^(true|false)$/i.test(sv)) sv = sv.toLowerCase() === 'true'
        else if (!Number.isNaN(Number(sv)) && sv !== '') sv = Number(sv)
        nested[sk] = sv
      }
      i = j - 1
      fm[key] = nested
      continue
    }
    let value: any = rest.trim()
    if (/^(true|false)$/i.test(value)) value = value.toLowerCase() === 'true'
    else if (!Number.isNaN(Number(value)) && value !== '') value = Number(value)
    fm[key] = value
  }
  const body = markdown.slice(fmMatch[0].length)
  return { fm, body }
}

export async function listPersonas(): Promise<PersonaSummary[]> {
  await ensureDir()
  const entries = await fs.readdir(CONFIG_AGENT_DIR, { withFileTypes: true })
  const list: PersonaSummary[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const full = path.join(CONFIG_AGENT_DIR, entry.name)
    try {
      const stat = await fs.stat(full)
      const raw = await fs.readFile(full, 'utf8')
      const { fm } = parseFrontmatter(raw)
      const id = entry.name.replace(/\.md$/, '')
      list.push({
        id,
        label: (fm['label'] as string) ?? undefined,
        description: (fm['description'] as string) ?? undefined,
        model: (fm['model'] as string) ?? undefined,
        mode: (fm['mode'] as string) ?? undefined,
        tools: (fm['tools'] && typeof fm['tools'] === 'object') ? (fm['tools'] as Record<string, unknown>) : undefined,
        permission: (fm['permission'] && typeof fm['permission'] === 'object') ? (fm['permission'] as Record<string, unknown>) : undefined,
        updatedAt: stat.mtime.toISOString()
      })
    } catch {
      // skip unreadable files
    }
  }
  return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function readPersona(id: string): Promise<PersonaDetail | null> {
  await ensureDir()
  try {
    const file = personaPathFor(id)
    const stat = await fs.stat(file)
    const markdown = await fs.readFile(file, 'utf8')
    const { fm, body } = parseFrontmatter(markdown)
    return { id: sanitizeId(id), markdown, frontmatter: fm, body, updatedAt: stat.mtime.toISOString() }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

export async function writePersona(id: string | undefined, markdown: string): Promise<{ id: string; path: string }> {
  await ensureDir()
  const parsedId = sanitizeId(id ?? (markdown ? `p-${Date.now()}` : `persona-${Date.now()}`))
  const file = personaPathFor(parsedId)
  // Basic validation: size and frontmatter presence
  if (typeof markdown !== 'string' || markdown.length === 0) {
    throw new Error('Empty markdown')
  }
  // prevent overly large files
  if (markdown.length > 200_000) throw new Error('Persona file too large')
  await fs.writeFile(file, markdown, 'utf8')
  return { id: parsedId, path: file }
}

export async function deletePersona(id: string): Promise<boolean> {
  await ensureDir()
  try {
    const file = personaPathFor(id)
    await fs.unlink(file)
    return true
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false
    throw err
  }
}

export default { listPersonas, readPersona, writePersona, deletePersona }
