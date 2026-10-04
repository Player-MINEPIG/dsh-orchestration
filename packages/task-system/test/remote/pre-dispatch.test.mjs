import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePayload, validatePreDispatchFailure } from '../../dist/remote/api.js'

const failure = { kind:'native-provider-unavailable-v1',code:'NO_ADAPTER',provider:'unmounted-provider',model:'configured-model' }
const payload = () => ({ runId:'run',attemptId:'attempt',fence:1,executionId:'owner',outcome:'blocked',summary:'System-owned preflight diagnostic',preDispatchFailure:{...failure} })
const validate = p => validatePayload({operation:'submit',nodeId:'worker',payload:p})

test('pre-dispatch wire evidence is a closed bounded shape and only accompanies reportless blocked settlement',()=>{
  assert.doesNotThrow(()=>validate(payload()))
  for(const changed of [
    {...failure,code:'MISSING_CREDENTIAL'},
    {...failure,kind:'untrusted-error'},
    {...failure,raw:'secret'},
    {...failure,provider:''},
    {...failure,model:'m'.repeat(201)},
  ]) assert.throws(()=>validatePreDispatchFailure(changed),/INVALID_PRE_DISPATCH_FAILURE/)
  assert.throws(()=>validate({...payload(),outcome:'success'}),/INVALID_PRE_DISPATCH_FAILURE/)
  assert.throws(()=>validate({...payload(),report:{title:'Made-up agent result',body:'Not observed'}}),/INVALID_PRE_DISPATCH_FAILURE/)
  assert.throws(()=>validate({...payload(),notifications:[]}),/PAYLOAD_FIELDS/)
})
