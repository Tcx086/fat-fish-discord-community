CREATE TABLE account_link_offers (
 token_hash TEXT PRIMARY KEY, identity TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE account_links (
 left_identity TEXT NOT NULL, right_identity TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(left_identity,right_identity)
);
CREATE TABLE processed_messages (
 scope TEXT NOT NULL, message_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(scope,message_id)
);
DROP TRIGGER event_delete;
CREATE TRIGGER event_delete BEFORE DELETE ON transcript_events BEGIN
 UPDATE memories SET status='deleted',content='',topic_key='',author='',approved_by=NULL,updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
 WHERE id IN (SELECT memory_id FROM memory_sources WHERE event_id=old.id);
 DELETE FROM memory_sources WHERE memory_id IN (SELECT memory_id FROM memory_sources WHERE event_id=old.id);
 INSERT INTO transcript_search(transcript_search,rowid,text) VALUES('delete',old.id,old.text);
END;
UPDATE memories SET topic_key='' WHERE status IN ('deleted','rejected','superseded');
PRAGMA user_version=2;
