import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Uses the actual installed DSH registry/storage services, without a production profile.
export async function attachWorkspaceRegistry(h) {
 const root=process.env.DSH_OFFICIAL_ROOT;
 if(!root)throw Error('Set DSH_OFFICIAL_ROOT to the isolated pinned runtime directory containing package.json and node_modules');
 const req=createRequire(join(root,'package.json'));
 for(const[name,options]of[['@deepseek-ai/dsh-storage',{}],['@deepseek-ai/dsh-storage-json',{root:join(h.dir,'workspace-storage')}],['@deepseek-ai/dsh-storage-domain',{backend:'json'}],['@deepseek-ai/dsh-workspace',{}]]) {
  const mod=await import(pathToFileURL(req.resolve(name)));
  await h.ctx.plugin(mod.default??mod,options);
 }
 await h.ctx.fiber.ready;
 return h.ctx.get('workspaceRegistry');
}
