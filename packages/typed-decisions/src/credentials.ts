/** Resolve at call time; values stay in the host credential store, never plugin config or public views. */
import type { Context } from '@deepseek-ai/cordis';
interface Store {
  resolve(ref: string): Promise<{ value: string } | undefined>;
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}
export function credentialStore(ctx: Context): Store | undefined { return ctx.get('credentials') as Store | undefined; }
export async function resolveApiKey(ctx: Context, ref: string): Promise<string | undefined> {
  if (!ref || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return undefined;
  const store = credentialStore(ctx);
  return store ? (await store.resolve(ref))?.value : process.env[ref]?.trim() || undefined;
}
export async function apiKeyStatus(ctx: Context, ref: string): Promise<{ configured: boolean; writable: boolean }> {
  const store = credentialStore(ctx);
  if (!ref || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return { configured: false, writable: false };
  if (store) {
    try { const info = await store.describe(ref); return { configured: info.configured, writable: info.writable }; }
    catch { return { configured: false, writable: false }; }
  }
  return { configured: !!process.env[ref]?.trim(), writable: false };
}
