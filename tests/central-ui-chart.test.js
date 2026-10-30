import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmedSeries,matchesLogLevel} from '../central/ui/src/chart.ts';

const hour=3600000;
test('hourly series keeps partial edge hours and all selected confirmations',()=>{
  const from=Date.UTC(2026,9,30,12,35),to=from+hour;
  const buckets=[{at:Date.UTC(2026,9,30,12),confirmed:2},{at:Date.UTC(2026,9,30,13),confirmed:3}];
  const points=confirmedSeries(buckets,from,to,'1h');
  assert.equal(points.length,2);
  assert.deepEqual(points.map(p=>p.count),[2,3]);
  assert.deepEqual(points.map(p=>p.partial),[true,true]);
});
test('24 hours includes both boundary hours, without dropping a bucket',()=>{
  const from=Date.UTC(2026,9,29,12,35),to=from+24*hour;
  const buckets=Array.from({length:25},(_,i)=>({at:Date.UTC(2026,9,29,12)+i*hour,confirmed:i+1}));
  const points=confirmedSeries(buckets,from,to,'24h');
  assert.equal(points.length,25);
  assert.equal(points.reduce((sum,p)=>sum+p.count,0),buckets.reduce((sum,b)=>sum+b.confirmed,0));
  assert.equal(points[0].partial,true);assert.equal(points.at(-1).partial,true);
});
test('seven day view sums whole hourly service buckets into days',()=>{
  const from=Date.UTC(2026,9,23,12,35),to=from+7*24*hour;
  const buckets=[{at:Date.UTC(2026,9,23,13),confirmed:1},{at:Date.UTC(2026,9,24,0),confirmed:2},{at:Date.UTC(2026,9,30,12),confirmed:3}];
  const points=confirmedSeries(buckets,from,to,'7d');
  assert.equal(points.reduce((sum,p)=>sum+p.count,0),6);
  assert.equal(points.length,8);
});
test('log level filter accepts core lowercase and warning aliases',()=>{
  assert.equal(matchesLogLevel('warning','WARN'),true);
  assert.equal(matchesLogLevel('info','INFO'),true);
  assert.equal(matchesLogLevel('error','ERROR'),true);
  assert.equal(matchesLogLevel('warning','ERROR'),false);
});
