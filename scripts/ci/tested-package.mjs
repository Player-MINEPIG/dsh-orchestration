import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export function preserveTestedPackage(pack, archive, resultsDirectory) {
  assert.equal(pack.filename, basename(pack.filename), 'Invalid package filename');
  assert.match(pack.filename, /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/);
  assert.equal(typeof pack.name, 'string');
  assert.equal(typeof pack.version, 'string');
  const bytes = readFileSync(archive);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const directory = join(resultsDirectory, 'packages');
  mkdirSync(directory, { recursive: true });
  const target = join(directory, pack.filename);
  if (existsSync(target)) {
    assert.equal(createHash('sha256').update(readFileSync(target)).digest('hex'), sha256,
      'Repeated package archives must contain exactly the same tested bytes');
  } else writeFileSync(target, bytes, { flag: 'wx' });
  const record = { name: pack.name, version: pack.version, filename: pack.filename, sha256 };
  writeFileSync(`${target}.json`, JSON.stringify(record, null, 2) + '\n');
  return record;
}
