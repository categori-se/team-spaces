import test from 'node:test';import assert from 'node:assert/strict';
import {requestResetOnAccess} from '../src/demo/on-demand-reset.js';
const now=Date.parse('2026-09-27T06:00:00Z');
test('no reset or lease before the deadline',async()=>{assert.equal(await requestResetOnAccess({pointer:{nextResetAt:'2026-09-28T05:00:00Z'},now,claim:()=>assert.fail(),invoke:()=>assert.fail()}),false);});
test('first access claims a bounded lease before invoking',async()=>{let lease,invoked=false;assert.equal(await requestResetOnAccess({pointer:{nextResetAt:'2026-09-27T05:00:00Z'},now,claim:async value=>{lease=value;},invoke:async()=>{assert.equal(lease,now+120000);invoked=true;}}),true);assert.equal(invoked,true);});
test('active lease or competing visitor never invokes another reset',async()=>{for(const locked of [true,false]){assert.equal(await requestResetOnAccess({pointer:{nextResetAt:'2026-09-27T05:00:00Z',resetLeaseUntil:locked?now+1000:0},now,claim:async()=>{const e=Error();e.name='ConditionalCheckFailedException';throw e;},invoke:()=>assert.fail()}),true);}});
test('expired lease retries; invocation failures remain failures',async()=>{await assert.rejects(requestResetOnAccess({pointer:{nextResetAt:'2026-09-27T05:00:00Z',resetLeaseUntil:now-1},now,claim:async()=>{},invoke:async()=>{throw Error('offline');}}),/offline/);});
test('unknown deadline never silently serves a stale demo',async()=>{await assert.rejects(requestResetOnAccess({pointer:{},now,claim:()=>assert.fail(),invoke:()=>assert.fail()}),/deadline/);});
