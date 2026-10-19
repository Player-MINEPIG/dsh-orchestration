import { insist } from "./remote/protocol.js";
import { z } from "zod";
const route=z.object({nodeId:z.string(),provider:z.string().min(1).max(100),model:z.string().min(1).max(200),reasoningEffort:z.string().optional(),requiredCapabilities:z.array(z.string()).default([])});
const status=z.object({executionRoutes:z.array(route).max(128).optional()}).passthrough();
export function pairedExecutorModels(nodeId:string,value:unknown) {
  const routes=status.parse(value ?? {}).executionRoutes ?? [];
  insist(!routes.some(row=>row.nodeId!==nodeId),"WRONG_EXECUTOR_CATALOG");
  const models=new Map<string,{provider:string;model:string;reasoningEfforts:string[]}>();
  for(const row of routes) {
    const key=JSON.stringify([row.provider,row.model]);
    const current=models.get(key) ?? {provider:row.provider,model:row.model,reasoningEfforts:[]};
    if(row.reasoningEffort && !current.reasoningEfforts.includes(row.reasoningEffort))current.reasoningEfforts.push(row.reasoningEffort);
    models.set(key,current);
  }
  return {models:[...models.values()],capabilities:[...new Set(routes.flatMap(row=>row.requiredCapabilities))]};
}
