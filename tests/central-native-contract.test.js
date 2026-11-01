import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validatePacket} from '../central/host/protocol.mjs';

test('every concrete extension bridge request crosses native message validation',()=>{
 const sources=['background.js','executor.js'].map(file=>readFileSync(new URL('../central/extension/'+file,import.meta.url),'utf8'));
 const types=new Set(sources.flatMap(source=>[...source.matchAll(/\btype\s*:\s*['"]([A-Z][A-Z0-9_]+)['"]/g)].map(match=>match[1])).filter(type=>!type.startsWith('DICO_')&&!type.startsWith('CENTRAL_')));
 for(const required of ['HELLO','CONNECTION_PROGRESS','RECOVERY_STATUS','DELIVERY_WAIT'])assert.ok(types.has(required));
 for(const type of types)assert.doesNotThrow(()=>validatePacket({requestId:'contract',message:{type}}),`Native host rejects extension message ${type}`);
 assert.throws(()=>validatePacket({requestId:'contract',message:{type:'NOT_A_PROTOCOL_MESSAGE'}}),/invalid native message/);
});
