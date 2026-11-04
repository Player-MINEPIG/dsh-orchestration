import { z } from "zod";
import { TaskError } from "./ledger.js";

export const stewardProjectInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(8000),
});

export function requestsNewProject(text: string): boolean {
  if (text.length > 16000 || /(?:不要|别|取消|暂停|暂缓|暂不|停止).{0,6}(?:创建|新建|建项目)|等我确认|等确认/u.test(text)) return false;
  const value = text.trim();
  const direct = /^(?:(?:请|麻烦|帮我|替我|给我|为我|管家[，,：:\s]*)\s*)+/u.test(value),
    personal = /^(?:我想|我要|我需要|我希望|(?:能|可以|可否|能否)(?:请)?(?:帮我|为我|替我))/u.test(value);
  if (/[?？]|怎么|如何|是否/u.test(value) && !direct && !personal) return false;
  return /^(?:(?:请|麻烦|帮我|替我|给我|为我|我想|我要|我需要|我希望|(?:能|可以|可否|能否)(?:请)?(?:帮我|为我|替我)|管家[，,：:\s]*)\s*)*(?:新建|创建|建立|开设|启动|建)(?:一个|个)?(?:新)?(?:项目|(?:叫|名为)[^，,。\n]{1,120}的?项目)/u.test(value) ||
    /^(?:please\s+)?(?:create|start|set up)\s+(?:a\s+)?new\s+project\b/iu.test(value);
}

export function suppliesProjectDetails(text: string): boolean {
  return text.length <= 8000 && /^(?:项目)?(?:就?叫|名(?:称|字)?[是为叫：:\s]|目标|title\s*[:=]|name\s*[:=]|goal\s*[:=])/iu.test(text.trim()) &&
    !/[?？]|取消|不要创建|不要新建/u.test(text);
}

export function authorizedProjectInput(text: string, input: unknown) {
  if (!requestsNewProject(text)) throw new TaskError("FORBIDDEN", "Only an explicit current user instruction to create a new project authorizes this tool");
  const parsed = stewardProjectInput.safeParse(input);
  if (!parsed.success) throw new TaskError("CLARIFICATION", "请补充新项目的名称和目标。");
  const complete = (tail: string, name: boolean) => /^\s*(?:$|[，,。；;！？?!\n”」》"']|吗[?？]?$)/u.test(tail) || name && /^的项目(?:$|[，,。；;！？?!\s])/u.test(tail);
  const named = [...text.matchAll(/(?:名称|名字|名为|叫|项目|title|name|project)\s*(?:[：:=]|是|为)?\s*[“「《"']?/giu)]
    .some(match => text.slice(match.index + match[0].length).startsWith(parsed.data.title) && complete(text.slice(match.index + match[0].length + parsed.data.title.length), true));
  const goal = [...text.matchAll(/(?:目标|目的|用于|用来|旨在|goal)\s*(?:[：:=]|是|为)?\s*[“「《"']?/giu)]
    .some(match => text.slice(match.index + match[0].length).startsWith(parsed.data.goal) && complete(text.slice(match.index + match[0].length + parsed.data.goal.length), false));
  if (!named || !goal)
    throw new TaskError("CLARIFICATION", "请明确新项目的名称和目标；管家不能自行补充创建内容。");
  return parsed.data;
}
