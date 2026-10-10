import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registrationPanel,registrationBadge} from '../public/registration-ui.js';
test('source acceptance labels, unknown source time and historical freshness stay separate from central review',()=>{
 const r={projectId:'p',registrationId:'r',namespace:'local/demo',projectExternalId:'demo',mode:'history',sourceRevision:1,origin:{harness:'<script>bad</script>'},observedAt:'2026-10-01T00:00:00Z',importedAt:'2026-10-11T00:00:00Z',unknownOriginalTimes:true,central:{revision:0,note:'',review:'unreviewed',revoked:false,withdrawn:false,evidenceReportIds:[]},sourceAcceptance:['unknown','pending_user','accepted','rejected'].map(acceptance=>({title:'Evidence',acceptance})),artifactAvailability:[]};
 const data={generatedAt:'2026-10-11T00:00:00Z',projectRegistrations:[r],reports:[]};const html=registrationPanel(data,'p');
 for(const label of ['未知','待用户验收','来源声称已验收','来源声称未通过','中央复核：尚未复核','账本时间是导入占位'])assert.ok(html.includes(label));assert.ok(!html.includes('<script>'));assert.match(registrationBadge(data,'p'),/历史快照已封存/);
});
