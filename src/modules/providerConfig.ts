import fs from 'fs/promises'
import path from 'path'

const DEFAULT_OPENCODE_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  permission: {
    edit: 'allow',
    bash: 'allow',
    webfetch: 'allow',
    doom_loop: 'allow',
    external_directory: 'deny'
  }
}

const ensureDirectory = async (dir: string) => {
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch {
    // best-effort
  }
}

async function ensureOpencodeConfig(sessionDir: string): Promise<void> {
  const configPath = path.join(sessionDir, 'opencode.json')
  try {
    await fs.access(configPath)
    return
  } catch {
    // fallthrough to create
  }
  await ensureDirectory(sessionDir)
  await fs.writeFile(configPath, JSON.stringify(DEFAULT_OPENCODE_CONFIG, null, 2), 'utf8')
}

/**
 * Provider-agnostic config bootstrap. Currently only writes a default
 * opencode config so the agent can run inside the workspace or docker.
 */
export async function ensureProviderConfig(sessionDir: string, providerId?: string, personaId?: string): Promise<void> {
  void providerId
  void personaId
  await ensureOpencodeConfig(sessionDir)
}
