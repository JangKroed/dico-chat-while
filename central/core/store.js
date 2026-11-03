/**
 * 중앙 상태와 이벤트를 SQLite에 함께 저장하는 영속 계층입니다.
 * WAL과 synchronous=FULL을 사용하며, 트랜잭션으로 상태와 이력의 불일치를 방지합니다.
 * 이 파일은 저장을 담당하고 발송 순서 등 업무 판단은 core/index.js에서 담당합니다.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

/** SQLite commits aggregate state and its event outbox in one durable transaction. */
export class CentralStore {
  constructor(path) {
    if (path !== ':memory:') {
      // databasePath must be inside the application's dedicated data directory.
      // SQLite derives sidecar permissions from the database at WAL creation.
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
      for (const suffix of ['-wal', '-shm']) {
        try { chmodSync(path + suffix, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new Error(`Unsupported central database schema ${version}; preserve this database and use a compatible runtime.`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS central_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_at ON events(at);
        PRAGMA user_version=1;`);
      const integrity = this.db.prepare('PRAGMA quick_check').get();
      if (Object.values(integrity)[0] !== 'ok') throw new Error('Central database integrity check failed; original database preserved.');
      if (path !== ':memory:') {
        for (const suffix of ['', '-wal', '-shm']) {
          try { chmodSync(path + suffix, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    } catch (error) { this.db.close(); throw error; }
  }
  read() { const row = this.db.prepare('SELECT data FROM central_state WHERE singleton=1').get(); return row ? JSON.parse(row.data) : null; }
  /**
   * 현재 저장 버전과 새 상태 버전을 비교하여 다른 쓰기 작업의 덮어쓰기를 감지합니다.
   * 이벤트 삽입과 상태 갱신을 하나의 트랜잭션으로 완료하거나 함께 되돌립니다.
   */
  commit(state, events) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT version FROM central_state WHERE singleton=1').get();
      if (current && current.version !== state.stateVersion - 1) throw new Error('Concurrent central writer detected');
      const persisted = events.map(event => {
        const row = this.db.prepare('INSERT INTO events(at,type,data) VALUES(?,?,?)').run(event.at,event.type,JSON.stringify(event));
        return { ...event, eventId: Number(row.lastInsertRowid) };
      });
      state.lastEventId = persisted.at(-1)?.eventId ?? state.lastEventId;
      const previous = this.db.prepare('SELECT data FROM central_state WHERE singleton=1').get();
      if(state.prunedBefore && (!previous || JSON.parse(previous.data).prunedBefore !== state.prunedBefore)){
        const protectedAttempts=state.attempts.filter(a=>['preparing','permitted','unknown'].includes(a.status)).map(a=>a.id);
        const protectedIncidents=state.incidents.filter(i=>i.status==='open').map(i=>i.id);
        const protectedCommands=state.commands.filter(c=>['queued','received'].includes(c.status)).map(c=>c.id);
        this.db.prepare(`DELETE FROM events WHERE at < ?
          AND COALESCE(json_extract(data,'$.attemptId'),'') NOT IN (SELECT value FROM json_each(?))
          AND COALESCE(json_extract(data,'$.incidentId'),'') NOT IN (SELECT value FROM json_each(?))
          AND COALESCE(json_extract(data,'$.commandId'),'') NOT IN (SELECT value FROM json_each(?))`).run(state.prunedBefore,JSON.stringify(protectedAttempts),JSON.stringify(protectedIncidents),JSON.stringify(protectedCommands));
      }

      this.db.prepare('INSERT INTO central_state(singleton,version,data) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,data=excluded.data').run(state.stateVersion,JSON.stringify(state));
      this.db.exec('COMMIT'); return persisted;
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  events({after=0,limit=200,from=0,to=Number.MAX_SAFE_INTEGER,type,groupId,instanceId,attemptId,level}={}) {
    const rows=this.db.prepare('SELECT event_id,data FROM events WHERE event_id>? AND at>=? AND at<=? ORDER BY event_id').iterate(Number(after)||0,Number(from)||0,Number(to)||Number.MAX_SAFE_INTEGER);
    const found=[];
    for(const row of rows){const event={...JSON.parse(row.data),eventId:row.event_id};
      if(type&&event.type!==type||groupId&&event.groupId!==groupId||instanceId&&event.instanceId!==instanceId||attemptId&&event.attemptId!==attemptId||level&&event.level!==level)continue;
      found.push(event);if(found.length>=Math.min(1000,Math.max(1,Number(limit)||200)))break;
    }return found;
  }
  eventPage({cursor,limit=100,from=0,to=Number.MAX_SAFE_INTEGER,level,query=''}={}) {
    const size=Math.min(500,Math.max(1,Number(limit)||100)),before=Number(cursor)||Number.MAX_SAFE_INTEGER,q=String(query).toLocaleLowerCase();
    const rows=this.db.prepare('SELECT event_id,data FROM events WHERE event_id < ? AND at >= ? AND at <= ? ORDER BY event_id DESC').iterate(before,Number(from)||0,Number(to)||Number.MAX_SAFE_INTEGER),items=[];
    for(const row of rows){const item={...JSON.parse(row.data),eventId:row.event_id};const normalizedLevel=String(item.level||'info').toLowerCase().replace('warning','warn');if(level&&level!=='all'&&normalizedLevel!==String(level).toLowerCase())continue;if(q&&!JSON.stringify(item).toLocaleLowerCase().includes(q))continue;items.push(item);if(items.length>size)break;}
    const hasMore=items.length>size;return{items:items.slice(0,size),nextCursor:hasMore?String(items[size-1].eventId):null};
  }
  recent(limit=100){return this.db.prepare('SELECT event_id,data FROM events ORDER BY event_id DESC LIMIT ?').all(limit).reverse().map(row=>({...JSON.parse(row.data),eventId:row.event_id}));}
  close(){this.db.close();}
}
