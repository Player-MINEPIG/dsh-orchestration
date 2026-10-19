import { realpath } from "node:fs/promises";

type Waiting = {
  enter: (release: () => void) => void;
  signal: AbortSignal;
  abort: () => void;
};
const locks = new Map<string, { waiting: Waiting[] }>();

/** Local and remote adapters share one lease for each actual cwd in this process. */
export async function acquireWorkspaceExecution(
  path: string,
  signal: AbortSignal,
): Promise<() => void> {
  const key = await realpath(path);
  signal.throwIfAborted();
  const releaseFor = (lock: { waiting: Waiting[] }) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = lock.waiting.shift();
      if (next) {
        next.signal.removeEventListener("abort", next.abort);
        next.enter(releaseFor(lock));
      } else locks.delete(key);
    };
  };
  const current = locks.get(key);
  if (!current) {
    const lock = { waiting: [] };
    locks.set(key, lock);
    return releaseFor(lock);
  }
  return await new Promise<() => void>((resolve, reject) => {
    const item: Waiting = {
      enter: resolve,
      signal,
      abort: () => {
        const index = current.waiting.indexOf(item);
        if (index >= 0) current.waiting.splice(index, 1);
        reject(
          signal.reason ??
            new Error("Execution cancelled while waiting for its workspace"),
        );
      },
    };
    current.waiting.push(item);
    signal.addEventListener("abort", item.abort, { once: true });
  });
}
