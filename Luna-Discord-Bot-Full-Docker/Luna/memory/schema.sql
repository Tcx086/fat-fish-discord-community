CREATE TABLE channel_settings (
 guild TEXT NOT NULL, channel TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
 epoch INTEGER NOT NULL DEFAULT 0, retention_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 authorized_by TEXT, PRIMARY KEY(guild,channel)
);
CREATE TABLE consent_records (
 guild TEXT NOT NULL, channel TEXT NOT NULL, speaker TEXT NOT NULL, granted INTEGER NOT NULL,
 version TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY(guild,channel,speaker),
 FOREIGN KEY(guild,channel) REFERENCES channel_settings(guild,channel)
);
CREATE TABLE conversation_sessions (
 id TEXT PRIMARY KEY, guild TEXT NOT NULL, channel TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
 FOREIGN KEY(guild,channel) REFERENCES channel_settings(guild,channel)
);
CREATE TABLE transcript_events (
 id INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, session TEXT NOT NULL REFERENCES conversation_sessions(id),
 guild TEXT NOT NULL, channel TEXT NOT NULL, speaker TEXT NOT NULL, event_at INTEGER NOT NULL,
 sequence INTEGER NOT NULL, text TEXT NOT NULL, collected_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 consent_version TEXT NOT NULL, provenance TEXT NOT NULL DEFAULT 'local-stt',
 FOREIGN KEY(guild,channel,speaker) REFERENCES consent_records(guild,channel,speaker)
);
CREATE INDEX event_scope_time ON transcript_events(guild,channel,event_at DESC,id DESC);
CREATE INDEX event_expiry ON transcript_events(expires_at);
CREATE TABLE memories (
 id TEXT PRIMARY KEY, guild TEXT NOT NULL, channel TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('summary','curated')),
 status TEXT NOT NULL CHECK(status IN ('candidate','approved','superseded','rejected','deleted')),
 content TEXT NOT NULL, topic_key TEXT NOT NULL, author TEXT NOT NULL, approved_by TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER,
 source_at INTEGER NOT NULL, provenance TEXT NOT NULL, supersedes TEXT REFERENCES memories(id) ON DELETE SET NULL,
 FOREIGN KEY(guild,channel) REFERENCES channel_settings(guild,channel)
);
CREATE UNIQUE INDEX one_active_topic ON memories(guild,channel,topic_key) WHERE status='approved' AND kind='curated';
CREATE INDEX memory_scope ON memories(guild,channel,status,kind);
CREATE TABLE memory_sources (
 memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
 event_id INTEGER NOT NULL REFERENCES transcript_events(id) ON DELETE CASCADE,
 PRIMARY KEY(memory_id,event_id)
);
CREATE INDEX sources_event ON memory_sources(event_id);
CREATE TABLE deletion_audit (
 id INTEGER PRIMARY KEY, guild TEXT NOT NULL, channel TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL, affected INTEGER NOT NULL
);
CREATE VIRTUAL TABLE transcript_search USING fts5(text, content='transcript_events', content_rowid='id', tokenize='trigram');
INSERT INTO transcript_search(transcript_search,rank) VALUES('secure-delete',1);
CREATE TRIGGER event_insert AFTER INSERT ON transcript_events BEGIN
 INSERT INTO transcript_search(rowid,text) VALUES(new.id,new.text);
END;
CREATE TRIGGER event_delete BEFORE DELETE ON transcript_events BEGIN
 UPDATE memories SET status='deleted',content='',author='',approved_by=NULL,updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
 WHERE id IN (SELECT memory_id FROM memory_sources WHERE event_id=old.id);
 DELETE FROM memory_sources WHERE memory_id IN (SELECT memory_id FROM memory_sources WHERE event_id=old.id);
 INSERT INTO transcript_search(transcript_search,rowid,text) VALUES('delete',old.id,old.text);
END;
PRAGMA user_version=1;
