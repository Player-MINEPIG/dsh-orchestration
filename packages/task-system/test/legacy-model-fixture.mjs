// Historic backend fixtures only. Production code never imports the replaced engine.
// Keep existing policy/staleness regression cases while new integration tests use real JEV.
import { DecisionEngine as LegacyEngine } from '../../typed-decisions/dist/core.js';
export {RulesProvider, StructuredModelProvider, JevProvider, AnyJevCompatibleProvider} from '../../typed-decisions/dist/core.js';
let serial=0;
export class DecisionEngine extends LegacyEngine {
  async ask(input,options={}) {
    const preset = this.options.presets?.find(p=>p.id===input.provider);
    const question = ([questionId,q])=>({questionId,questionVersion:'1',instructions:q.instructions,type:q.type,...(q.type==='choice'?{candidates:q.criteria}:q.type==='score'?{levels:q.criteria}:q.criteria?{criteria:q.criteria}:{})});
    const questions=Object.entries(input.questions).map(question);
    if (input.questions.workspace && !input.questions.session) questions.push({questionId:'session',questionVersion:'1',type:'choice',instructions:'Only new is eligible',candidates:{new:'New session'}});
    const result=await this.evaluate({requestId:`fixture-${serial++}`,stateHash:'fixture',context:JSON.parse(input.state),questions,...(preset?{preset:preset.id}:input.provider?{provider:input.provider}:{}),...(input.model?{model:input.model}:{}),...(input.reasoningEffort?{reasoningEffort:input.reasoningEffort}:{})},options);
    if(result.status!=='answered')throw Error('fixture failed');
    return {provider:result.provider,model:result.model,answers:Object.fromEntries(Object.entries(result.answers).filter(([id])=>Object.hasOwn(input.questions,id))),...(result.usage?{usage:result.usage}:{})};
  }
}
