import {getEventListeners} from 'node:events';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const workspace=process.argv[2]??'/private/tmp/dsh-origin-return-tools-workspace';
const {createNativeHarness}=await import(pathToFileURL(join(workspace,'tests/dsh/native-harness.mjs')));
const h=await createNativeHarness({script:['one','two','three']});let handle;
try {
 handle=await h.ctx.agents.create({sessionId:'listener-origin',meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
 const delivery=h.ctx.taskSystem.taskReturns;
 for(let i=0;i<3;i++)await delivery.deliver({messageId:'return-'+i,sessionId:'listener-origin',nodeId:'local',taskId:'child',text:'result '+i,completion:{eventId:'return-'+i,origin:{kind:'session',nodeId:'local',sessionId:'listener-origin',cwd:h.dir,composition:{provider:'test-offline',model:'script',tools:[]}}}});
 process.stdout.write(JSON.stringify({completedDeliveries:3,remainingLifetimeAbortListeners:getEventListeners(delivery.lifetime.signal,'abort').length})+'\n');
} finally {await handle?.dispose();await h.dispose();}
