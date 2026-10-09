import test from 'node:test';
import assert from 'node:assert/strict';
import {assertResourcePool, assertPoolAllocation, proposePoolReservation} from '../src/resource-pools.js';
const pool = {schema_version: 1, pool_id: 'p', authority: 'https://trader.example/api', workspace_id: 'w', account_id: 'a', sponsor: {type: 'organization', id: 'org'},
  kind: 'strategy_slots', unit: 'count', currency: null, limit: 6, used: 2, reserved: 0, period: {id: 'month', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z'}, status: 'active', revision: 1};
const context = {workspaceId: 'w', accountId: 'a', now: Date.parse('2026-10-09T00:00:00Z')};
test('sponsorship and collection allocation preserve explicit owning scope and supply no permissions', () => {
  assert.equal(assertResourcePool(pool).sponsor.type, 'organization');
  const allocation = {schema_version: 1, allocation_id: 'x', pool_id: 'p', workspace_id: 'w', account_id: 'a', target: {type: 'collection', id: 'c'}, limit: 2};
  assert.equal(assertPoolAllocation(allocation, pool).permissions, undefined);
  assert.throws(() => assertPoolAllocation({...allocation, workspace_id: 'foreign'}, pool));
});
test('reservation proposals enforce period, lifecycle, account and total capacity without mutating prior accounting', () => {
  assert.equal(proposePoolReservation(pool, 4, context).reserved, 4); assert.equal(pool.reserved, 0);
  for (const change of [{accountId: 'other'}, {workspaceId: 'other'}, {now: Date.parse(pool.period.ends_at)}]) assert.throws(() => proposePoolReservation(pool, 1, {...context, ...change}));
  assert.throws(() => proposePoolReservation(pool, 5, context)); assert.throws(() => proposePoolReservation({...pool, status: 'suspended'}, 1, context));
});
test('financial capital, currency units, provider authority and invalid arithmetic cannot be silently combined', () => {
  for (const change of [{kind: 'experiment_capital'}, {currency: 'USD'}, {used: 7}, {reserved: -1}, {limit: 1.5}, {permissions: ['view']}, {authority: 'https://user:secret@example.com'}]) assert.throws(() => assertResourcePool({...pool, ...change}));
  assert.equal(assertResourcePool({...pool, kind: 'experiment_capital', unit: 'currency_minor', currency: 'USD'}).kind, 'experiment_capital');
});
