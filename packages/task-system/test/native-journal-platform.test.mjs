import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeResultJournal} from '../dist/native-result-journal.js';

// The same regression runs against the native platform in Windows and POSIX CI.
test('new journal syncs a writable file on Windows and ancestor directories elsewhere', () => {
  
  const originalSync=fs.fsyncSync,originalOpen=fs.openSync;
  for(const platform of [process.platform]) {
    const root=fs.mkdtempSync(join(tmpdir(),'journal-platform-'));
    const file=join(root,'new','nested','results.sqlite');
    const synced=[],opens=[];let journal;
    try {
      
      fs.openSync=(path,flags,...args)=>{opens.push({path,flags});return originalOpen(path,flags,...args);};
      fs.fsyncSync=fd=>synced.push(fs.fstatSync(fd).isDirectory()?'directory':'file');
      syncBuiltinESMExports();
      journal=NativeResultJournal.open(file);
      assert.equal(journal.db.prepare('PRAGMA synchronous').get().synchronous,2);
      assert.equal(journal.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
      assert.deepEqual(synced,platform==='win32'?['file']:['directory','directory','directory']);
      if(platform==='win32') assert.ok(opens.some(x=>x.path===file&&x.flags==='r+'));
    } finally {
      journal?.close();
      fs.fsyncSync=originalSync;fs.openSync=originalOpen;syncBuiltinESMExports();
      fs.rmSync(root,{recursive:true,force:true});
    }
  }
});

test('sync errors propagate on Windows files and POSIX directories; handles close', () => {
  const original=fs.fsyncSync;
  for(const platform of [process.platform]) for(const code of ['EPERM','EIO']) {
    const root=fs.mkdtempSync(join(tmpdir(),'journal-sync-error-'));let descriptorUsed;
    const error=Object.assign(new Error('injected I/O failure'),{code});
    try {
      
      fs.fsyncSync=fd=>{descriptorUsed=fd;throw error;};syncBuiltinESMExports();
      assert.throws(()=>NativeResultJournal.open(join(root,'new','results.sqlite')),caught=>caught===error);
      assert.throws(()=>fs.fstatSync(descriptorUsed),{code:'EBADF'});
    } finally {
      fs.fsyncSync=original;syncBuiltinESMExports();
      fs.rmSync(root,{recursive:true,force:true});
    }
  }
});

test('actual host can create a new journal and reopen persisted ready results', () => {
  const root=fs.mkdtempSync(join(tmpdir(),'journal-host-')),file=join(root,'nested','results.sqlite');
  const ref={runId:'run',attemptId:'attempt',nodeId:'local',fence:1,executionId:'execution'};
  const value={commandId:'result',ref,sessionId:'session',readyAt:Date.now(),settlement:{...ref,outcome:'success',summary:'verified'},quiescent:true,sessionPersisted:true};
  let journal;
  try {
    journal=NativeResultJournal.open(file);journal.ready(value);journal.close();
    journal=NativeResultJournal.open(file);
    assert.deepEqual(journal.get('result').settlement,value.settlement);
    assert.equal(journal.db.prepare('PRAGMA synchronous').get().synchronous,2);
  } finally {journal?.close();fs.rmSync(root,{recursive:true,force:true});}
});
