import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

test('shipped task and session contracts import outside the workspace without a decision plugin package', async () => {
  const dir=mkdtempSync(join(tmpdir(),'task-contract-standalone-'));
  try {
    writeFileSync(join(dir,'package.json'),JSON.stringify({type:'module'}));
    cpSync(new URL('../dist/',import.meta.url),join(dir,'dist'),{recursive:true});
    const require=createRequire(join(dir,'package.json'));
    assert.throws(()=>require.resolve('@dsh-task/typed-decisions/validation'),{code:'MODULE_NOT_FOUND'});
    const contract=await import(pathToFileURL(join(dir,'dist/decision-validation.js')));
    const task=await import(pathToFileURL(join(dir,'dist/task-policy.js')));
    const session=await import(pathToFileURL(join(dir,'dist/session-policy.js')));
    assert.equal(typeof task.buildTaskDecisionRequest,'function');
    assert.equal(typeof session.resolveTaskSessionDecision,'function');
    assert.throws(()=>contract.validateRequest({requestId:'invalid'}),/missing/);
    assert.equal(contract.stableStringify({b:2,a:1}),'{'+'"a":1,"b":2}');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
