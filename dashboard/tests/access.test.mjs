import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT,createLocalJWKSet,exportJWK} from 'jose';
import {accessConfiguration,createAccessAuthorizer} from '../access.mjs';
import {liveConfiguration} from '../live-server.mjs';
const configuration={teamDomain:'https://test-team.cloudflareaccess.com',audience:'test-audience',ownerEmail:'owner@example.test',publicOrigin:'https://tasks.example.test'};
const {privateKey,publicKey}=await generateKeyPair('RS256');
const other=await generateKeyPair('RS256');
const jwk={...await exportJWK(publicKey),kid:'test-key',alg:'RS256'};
const resolver=createLocalJWKSet({keys:[jwk]});
const authorize=createAccessAuthorizer(configuration,{keyResolver:resolver});
const now=()=>Math.floor(Date.now()/1000);
async function token(patch={},header={},key=privateKey){const at=now();return new SignJWT({iss:configuration.teamDomain,aud:[configuration.audience],sub:'test-owner',email:configuration.ownerEmail,iat:at,nbf:at,exp:at+300,type:'app',...patch}).setProtectedHeader({alg:'RS256',kid:'test-key',...header}).sign(key);}
const request=value=>({headers:{host:'tasks.example.test','cf-access-jwt-assertion':value}});
test('verified owner application grants only expiry metadata',async()=>{const result=await authorize(request(await token()));assert.deepEqual(Object.keys(result),['expiresAt']);assert.ok(result.expiresAt>Date.now());});
test('identity, app audience, issuer, time and signature failures all deny',async()=>{
 for(const patch of [{email:'other@example.test'},{email:undefined},{aud:['another-app']},{iss:'https://other.cloudflareaccess.com'},{exp:now()},{exp:undefined},{nbf:now()+60},{nbf:undefined},{iat:undefined},{sub:''},{type:'org'}]) assert.equal(await authorize(request(await token(patch))),false,JSON.stringify(patch));
 assert.equal(await authorize(request(await token({}, {},other.privateKey))),false);
 const signed=await token();assert.equal(await authorize(request(signed.slice(0,-6)+'tamper')),false);
});
test('untrusted headers, algorithms, malformed input and host cannot authorize',async()=>{
 for(const bad of [undefined,'','malformed',['a','b'],'x'.repeat(16385)]) assert.equal(await authorize(request(bad)),false);
 const signed=await token();assert.equal(await authorize({...request(signed),headers:{...request(signed).headers,host:'evil.example.test'}}),false);
 assert.equal(await authorize({headers:{host:'tasks.example.test','cf-access-authenticated-user-email':configuration.ownerEmail}}),false);
 const hs=await new SignJWT({email:configuration.ownerEmail}).setProtectedHeader({alg:'HS256'}).sign(new Uint8Array(32));assert.equal(await authorize(request(hs)),false);
});
test('key retrieval failures fail closed; token key URLs never choose the resolver',async()=>{
 const denied=createAccessAuthorizer(configuration,{keyResolver:async()=>{throw new Error('private retrieval details');}});assert.equal(await denied(request(await token())),false);
 const signed=await token({}, {jku:'https://attacker.invalid/keys',x5u:'https://attacker.invalid/key'});assert.ok(await authorize(request(signed)));
});
test('configuration rejects missing or unsafe trust origins and owner identity',()=>{
 for(const teamDomain of [undefined,'http://test-team.cloudflareaccess.com','https://test-team.cloudflareaccess.com.evil.test','https://test-team.cloudflareaccess.com/a','https://user@test-team.cloudflareaccess.com','https://test-team.cloudflareaccess.com:8443','https://test-team.cloudflareaccess.com?x=1']) assert.throws(()=>accessConfiguration({...configuration,teamDomain}));
 for(const patch of [{audience:''},{ownerEmail:''},{publicOrigin:'http://tasks.example.test'},{publicOrigin:'https://tasks.example.test/path'}])assert.throws(()=>accessConfiguration({...configuration,...patch}));
});
test('live origin requires explicit existing-ledger path and has no public-bind option',()=>{
 const env={DSH_DASHBOARD_LEDGER:'/tmp/existing.sqlite',CF_ACCESS_TEAM_DOMAIN:configuration.teamDomain,CF_ACCESS_AUD:configuration.audience,CF_ACCESS_OWNER_EMAIL:configuration.ownerEmail,DSH_DASHBOARD_PUBLIC_ORIGIN:configuration.publicOrigin};
 assert.equal(liveConfiguration(env).port,4317);
 for(const patch of [{DSH_DASHBOARD_LEDGER:''},{DSH_DASHBOARD_LEDGER:'relative.sqlite'},{DSH_DASHBOARD_PORT:'18440'},{DSH_DASHBOARD_PORT:'80'},{CF_ACCESS_AUD:''},{DSH_DASHBOARD_BASE_PATH:'//outside'}]) assert.throws(()=>liveConfiguration({...env,...patch}));
});
