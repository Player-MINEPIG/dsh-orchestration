/** Pure migration: no credentials are resolved, copied or printed; no task state is changed. */
export function migrateDecisionConfig(decision={}, completion={}, task={}) {
  const providers=decision.providers ?? [{id:'rules',kind:'rules',rules:[]}]
  const presets=decision.presets?.length ? decision.presets : [{id:'default',name:'Current default',provider:decision.defaultProvider ?? 'rules'}]
  const profiles=[],warnings=[]
  const profileFor=(selection,id,name)=>{
    const p=providers.find(p=>p.id===selection.provider)
    if(!p)throw Error('Migration references an unknown provider')
    if(p.kind==='rules') {
      warnings.push({id,kind:'caller-rule',empty:!(p.rules?.length),requiresManualMigration:!!p.rules?.length})
      return undefined
    }
    if(p.kind==='structured') {
      const selector=selection.model ?? p.models?.[0]?.model
      const route=(completion.routes ?? []).find(r=>r.model===selector)
      if(!route)throw Error('Migration is missing a configured native DSH route')
      return {id,name,provider:'native',nativeProvider:route.provider,model:route.modelVersion,...(selection.reasoningEffort?{reasoningEffort:selection.reasoningEffort}:{})}
    }
    if(p.kind==='jev')return {id,name,provider:'typesafe',model:selection.model ?? p.model,...(p.apiKeyEnv?{credential:p.apiKeyEnv}:{})}
    if(p.kind==='compatible')return {id,name,provider:'custom',baseUrl:p.endpoint,model:selection.model ?? p.model,...(p.apiKeyEnv?{credential:p.apiKeyEnv}:{})}
    throw Error('Migration does not support this provider kind')
  }
  for(const preset of presets){const p=profileFor(preset,preset.id,preset.name ?? preset.id);if(p)profiles.push(p)}
  for(const p of providers.filter(p=>p.kind!=='rules')) if(!profiles.some(x=>x.id===p.id)) {
    const profile=profileFor({provider:p.id},p.id,p.id);if(profile)profiles.push(profile)
  }
  const fallback=decision.defaultPreset || (decision.presets?.length ? undefined : 'default')
  const defaultSelection=presets.find(p=>p.id===fallback) ?? {provider:decision.defaultProvider ?? 'rules'}
  const defaultProfile=profileFor(defaultSelection,'current-default','Current default')
  const bindings={...task.decisionBindings}
  const taskChanges={decisionBindings:bindings}
  for(const [consumer,key] of [['task-planning','planningDecisionEnabled'],['task-session','sessionDecisionEnabled']]) {
    const selected=decision.bindings?.[consumer] || fallback
    if(selected && profiles.some(p=>p.id===selected))bindings[consumer]=selected
    else if(defaultProfile)bindings[consumer]=''
    else {
      const p=selected?presets.find(p=>p.id===selected):defaultSelection
      const rule=providers.find(x=>x.id===p?.provider)
      if(rule?.rules?.length)throw Error('Active caller rules require explicit business-side migration before switching')
      // Old empty rules always abstained. Preserve deterministic caller defaults without paid model calls.
      taskChanges[key]=false;bindings[consumer]=''
    }
  }
  const {id,name,...defaults}=defaultProfile ?? profiles[0] ?? {provider:'typesafe'}
  return {jev:{enabled:true,...defaults,profiles,timeoutMs:decision.timeoutMs ?? completion.maxRuntimeMs ?? 60000,maxOutputTokens:completion.maxOutputTokens ?? 2048,maxStateChars:Math.min(40000,completion.maxInputBytes ?? 40000),maxOutputBytes:completion.maxOutputBytes ?? 1048576,dailyCallLimit:0,dailyTokenLimit:0},taskChanges,warnings}
}
