import { fetchJson } from './http'
import type { GitInfo } from '../types/git'

type GitResponse = {
  git: GitInfo | null
}

async function postGitAction(projectId: string, action: string, body: Record<string, unknown>): Promise<GitInfo | null> {
  const payload = await fetchJson<GitResponse>(`/api/projects/${projectId}/git/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return payload.git ?? null
}

export async function commitGitChanges(projectId: string, message: string): Promise<GitInfo | null> {
  return await postGitAction(projectId, 'commit', { message })
}

export async function stageGitPaths(projectId: string, paths: string[]): Promise<GitInfo | null> {
  return await postGitAction(projectId, 'stage', { paths, mode: 'stage' })
}

export async function unstageGitPaths(projectId: string, paths: string[]): Promise<GitInfo | null> {
  return await postGitAction(projectId, 'stage', { paths, mode: 'unstage' })
}

export async function discardGitPath(projectId: string, path: string, isUntracked: boolean): Promise<GitInfo | null> {
  return await postGitAction(projectId, 'discard', { path, isUntracked })
}

export async function stashGitPath(projectId: string, path: string): Promise<GitInfo | null> {
  return await postGitAction(projectId, 'stash', { path })
}

export async function unstashGitPath(projectId: string, path: string): Promise<GitInfo | null> {
  return await postGitAction(projectId, 'unstash', { path })
}

export async function checkoutGitRef(projectId: string, ref: string): Promise<GitInfo | null> {
  return await postGitAction(projectId, 'checkout', { ref })
}
