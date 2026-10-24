import { win32 } from 'node:path'

export function isCanonicalWindowsWorkspacePath(path: string): boolean {
  if (!win32.isAbsolute(path)) return false
  const normalized = win32.normalize(path)
  if (normalized === path) return true
  return /^[A-Za-z]:\//.test(path) &&
    !path.includes('\\') && normalized === path.replaceAll('/', '\\')
}
