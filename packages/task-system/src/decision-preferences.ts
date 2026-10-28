import type { Context } from '@deepseek-ai/cordis';
import type { TaskSystemService } from './dsh-plugin.js';
import {digest} from './decision-validation.js';
export function readDecisionPreferences(ctx:Context) {
  const cfg = ctx.get('decisionModels')?.config();
  const task = ctx.get('taskSystem') as TaskSystemService | undefined;
  const bindings = structuredClone(task?.config.decisionBindings ?? {});
  const presets = (cfg?.profiles ?? []).map(p=>({id:p.id,name:p.name || p.id,provider:p.provider,model:p.model ?? ''}));
  return {available:!!cfg,writable:!!cfg && !!ctx.get('configEditor'),presets,bindings,revision:digest({presets,bindings}),defaultProvider:cfg?.provider ?? '',defaultModel:cfg?.model ?? ''};
}
/** The caller owns which configured model profile to use for each business question. */
export async function saveDecisionPreference(ctx:Context,input:{expected:string;consumer:'task-planning';id:string}) {
  const current = readDecisionPreferences(ctx);
  if (current.revision !== input.expected) throw new Error('DECISION_CONFLICT');
  if (input.id && !current.presets.some(p=>p.id === input.id)) throw new Error('DECISION_PROFILE_MISSING');
  const editor = ctx.get('configEditor') as {entries():Iterable<{options:{id:string;name:string;config?:Record<string,unknown>}}>;edit(entry:unknown,change:(config:Record<string,unknown>)=>Record<string,unknown>):Promise<void>} | undefined;
  const entry = [...(editor?.entries() ?? [])].find(e=>e.options.name === '@dsh-task/task-system/plugin');
  if (!editor || !entry || !current.available) throw new Error('DECISION_READ_ONLY');
  const owns = (rows:unknown[]):boolean => rows.some(value=>{const p=value as {id?:string;name?:string;config?:unknown;insert?:unknown[]};return ((p.id===entry.options.id || p.name===entry.options.name) && Object.hasOwn(p,'config')) || (Array.isArray(p.insert) && owns(p.insert));});
  const profile = ctx.get('profileContext') as {overlays?:unknown[]} | undefined;
  if (owns(profile?.overlays ?? [])) throw new Error('DECISION_OVERRIDE');
  await editor.edit(entry,raw=>{
    if (readDecisionPreferences(ctx).revision !== input.expected) throw new Error('DECISION_CONFLICT');
    return {...raw,decisionBindings:{...raw.decisionBindings as Record<string,string>,[input.consumer]:input.id}};
  });
  return {saved:true,applies:'live' as const};
}
