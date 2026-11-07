import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

/** The native filesystem tools retain their own sandbox and approval checks. */
export function workbenchFileAllowed(cwd: string, args: unknown): boolean {
  const parsed = z.object({ file_path: z.string().min(1) }).safeParse(args);
  if (!parsed.success) return false;
  const inside = (root: string, target: string) => {
    const path = relative(root, target);
    return path === "" || !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
  };
  try {
    const root = realpathSync(cwd), target = resolve(root, parsed.data.file_path);
    if (!inside(root, target)) return false;
    let ancestor = target;
    while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
    return inside(root, realpathSync(ancestor));
  } catch { return false; }
}
