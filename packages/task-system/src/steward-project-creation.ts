import { z } from "zod";
import { TaskError } from "./ledger.js";

export const stewardProjectInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(8000),
});

export function cancelsProjectCreation(text: string): boolean {
  return text.split(/[，,。；;\n]/u).some(fragment => /^(?:(?:但|不过|请|先|暂时|现在|这次|本次|也)\s*)*(?:(?:取消|停止|暂停|暂缓|不要|别|暂不)\s*(?:(?:刚才|之前|上面|这个|那个|该|本次|这次)(?:的)?\s*)?(?:(?:创建|新建|建项|建项目)(?:一个|个)?(?:新)?(?:项目)?|项目(?:创建|新建)?)(?:吧|了)?[！!？?]?|等我?确认(?:再创建(?:项目)?)?)$/u.test(fragment.trim()));
}

export function requestsNewProject(text: string): boolean {
  if (text.length > 16000 || cancelsProjectCreation(text)) return false;
  const value = text.trim();
  const direct = /^(?:(?:请|麻烦|帮我|替我|给我|为我|管家[，,：:\s]*)\s*)+/u.test(value),
    personal = /^(?:我想|我要|我需要|我希望|(?:能|可以|可否|能否)(?:请)?(?:帮我|为我|替我))/u.test(value);
  if (/[?？]|怎么|如何|是否/u.test(value) && !direct && !personal) return false;
  return /^(?:(?:请|麻烦|帮我|替我|给我|为我|我想|我要|我需要|我希望|(?:能|可以|可否|能否)(?:请)?(?:帮我|为我|替我)|管家[，,：:\s]*)\s*)*(?:新建|创建|建立|开设|启动|建)(?:一个|个)?(?:新)?(?:项目|(?:叫|名为)[^，,。\n]{1,120}的?项目)/u.test(value) ||
    /^(?:please\s+)?(?:create|start|set up)\s+(?:a\s+)?new\s+project\b/iu.test(value);
}

export function suppliesProjectDetails(text: string): boolean {
  return text.length <= 8000 && /^(?:项目)?(?:就?叫|名(?:称|字)?[是为叫：:\s]|目标|title\s*[:=]|name\s*[:=]|goal\s*[:=])/iu.test(text.trim()) &&
    !/[?？]/u.test(text) && !cancelsProjectCreation(text);
}

/** A delegation is meaningful only inside an independently verified pending creation chain. */
export function delegatesProjectDetails(text: string): boolean {
  return text.length <= 1000 && !/[?？]|取消|不要|暂不|等我|[“”「」>]/u.test(text) &&
    /^(?:标题(?:和|、|及)目标[，,：:\s]*)?(?:你(?:自己|来)?|管家|自行)(?:来)?(?:写|拟定|拟写|决定|定|安排)(?:一下|即可|就行|吧|好了|名称|名字|标题|目标|都可以|都行|[，,。\s])*$/u.test(text.trim());
}

export function authorizedProjectInput(text: string, input: unknown, delegated = false) {
  if (!requestsNewProject(text)) throw new TaskError("FORBIDDEN", "Only an explicit current user instruction to create a new project authorizes this tool");
  const parsed = stewardProjectInput.safeParse(input);
  if (!parsed.success) throw new TaskError("CLARIFICATION", "请补充新项目的名称和目标。");
  const complete = (tail: string, name: boolean) => /^\s*(?:$|[，,。；;！？?!\n”」》"']|吗[?？]?$)/u.test(tail) || name && /^的项目(?:$|[，,。；;！？?!\s])/u.test(tail);
  const named = [...text.matchAll(/(?:名称|名字|名为|叫|项目|title|name|project)\s*(?:[：:=]|是|为)?\s*[“「《"']?/giu)]
    .some(match => text.slice(match.index + match[0].length).startsWith(parsed.data.title) && complete(text.slice(match.index + match[0].length + parsed.data.title.length), true));
  const goal = [...text.matchAll(/(?:目标|目的|用于|用来|旨在|goal)\s*(?:[：:=]|是|为)?\s*[“「《"']?/giu)]
    .some(match => text.slice(match.index + match[0].length).startsWith(parsed.data.goal) && complete(text.slice(match.index + match[0].length + parsed.data.goal.length), false));
  const fragments = text.split("\n").filter(fragment => !delegatesProjectDetails(fragment));
  const latestTitle = fragments.flatMap(fragment => [...fragment.matchAll(/(?:名称|名字|名为|就?叫|title|name)\s*(?:[：:=]|是|为)?\s*[“「《"']?([^，,。；;\n”」》"']+)/giu)].map(match => match[1]?.trim().replace(/的项目$/u, ""))).filter(Boolean).at(-1);
  const latestGoal = fragments.flatMap(fragment => [...fragment.matchAll(/(?:目标|目的|用于|用来|旨在|goal)\s*(?:[：:=]|是|为)?\s*[“「《"']?(.+)/giu)].map(match => match[1]?.split(/[,，;；]\s*(?:名称|名字|名为|title|name)\s*[：:=]/iu)[0]?.trim())).filter(Boolean).at(-1);
  const normalize = (value: string) => value.trim().replace(/[。！？?!]+$/u, "").replace(/吗$/u, "");
  if (latestTitle && normalize(latestTitle) !== normalize(parsed.data.title) || latestGoal && normalize(latestGoal) !== normalize(parsed.data.goal))
    throw new TaskError("CLARIFICATION", "请完整保留用户最新明确提供的项目名称和目标，不能用先前的拟写授权覆盖它们。");
  if (delegated) {
    const proposed = stewardProjectInput.safeParse({ ...parsed.data, goal: `${parsed.data.goal}\n\n原始用户创建需求及有效澄清（必须完整保留）：${text}` });
    if (!proposed.success) throw new TaskError("CLARIFICATION", "原始需求必须完整保留；请缩短拟定目标或先整理本次创建需求，目标总长不得超过8000字。");
    return proposed.data;
  }
  if (!named || !goal)
    throw new TaskError("CLARIFICATION", "请明确新项目的名称和目标；管家不能自行补充创建内容。");
  return parsed.data;
}
