import type { DatabaseSync } from 'node:sqlite';
/** Imported source packets can contain complete histories. UI lists use only their public receipts. */
export function prepareProjectReadIndex(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS registration_read_headers(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,seq INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS registration_header_project ON registration_read_headers(project_id,seq DESC);`);
  const select=(row:string)=>`${row}.id,json_extract(${row}.data,'$.projectId'),${row}.rowid,json_object(
    'registrationId',json_extract(${row}.data,'$.registrationId'),'projectId',json_extract(${row}.data,'$.projectId'),
    'namespace',json_extract(${row}.data,'$.namespace'),'mode',json_extract(${row}.data,'$.mode'),'sourceRevision',json_extract(${row}.data,'$.sourceRevision'),
    'observedAt',json_extract(${row}.data,'$.observedAt'),'staleAfterMs',json_extract(${row}.data,'$.staleAfterMs'),'origin',json_object('harness',json_extract(${row}.data,'$.origin.harness')),
    'central',json_extract(${row}.data,'$.central'),'unknownOriginalTimes',json_extract(${row}.data,'$.packet.project.createdAt') IS NULL,
    'sourceAcceptance',(SELECT json_group_array(json_object('title',json_extract(o.value,'$.title'),'acceptance',json_extract(o.value,'$.acceptance'))) FROM json_each(${row}.data,'$.packet.outcomes') o),
    'artifactAvailability',(SELECT json_group_array(json_object('uri',json_extract(a.value,'$.uri'),'availability',json_extract(a.value,'$.availability'))) FROM json_each(${row}.data,'$.packet.artifacts') a))`;
  for(const operation of ['INSERT','UPDATE'])db.exec(`CREATE TRIGGER IF NOT EXISTS demand_registration_${operation.toLowerCase()} AFTER ${operation} ON entities WHEN NEW.kind='registration' BEGIN INSERT INTO registration_read_headers SELECT ${select('NEW')} ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,seq=excluded.seq,data=excluded.data;END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS demand_registration_delete AFTER DELETE ON entities WHEN OLD.kind='registration' BEGIN DELETE FROM registration_read_headers WHERE id=OLD.id;END;
    INSERT INTO registration_read_headers SELECT ${select('s')} FROM entities s WHERE s.kind='registration' AND NOT EXISTS(SELECT 1 FROM registration_read_headers h WHERE h.id=s.id);`);
}
