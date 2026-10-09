// @ts-nocheck -- Runtime contracts are enforced by the package conformance suite.
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const kinds = Object.freeze({storage: 'bytes', compute: 'milliseconds', ai_spend: 'currency_minor', delivery: 'bytes', strategy_slots: 'count', experiment_capital: 'currency_minor'});
export const resourcePoolKinds = Object.freeze(Object.keys(kinds));

// Capacity correspondence supplies no resource permission or provider authority.
export function assertResourcePool(value) {
  const fields = ['schema_version', 'pool_id', 'authority', 'workspace_id', 'account_id', 'sponsor', 'kind', 'unit', 'currency', 'limit', 'used', 'reserved', 'period', 'status', 'revision'];
  if (!plain(value) || Object.keys(value).sort().join() !== fields.sort().join() || value.schema_version !== 1 || !id(value.pool_id) || !id(value.workspace_id) || !id(value.account_id) ||
      typeof value.authority !== 'string' || value.authority.length > 500 || !/^(https:\/\/|arn:aws:)/.test(value.authority) || /[\s@?#]/.test(value.authority) ||
      !plain(value.sponsor) || Object.keys(value.sponsor).sort().join() !== 'id,type' || !['user', 'organization', 'account'].includes(value.sponsor.type) || !id(value.sponsor.id) ||
      !Object.hasOwn(kinds, value.kind) || value.unit !== kinds[value.kind] || !['active', 'suspended', 'revoked'].includes(value.status) ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || ![value.limit, value.used, value.reserved].every(integer) || !Number.isSafeInteger(value.used + value.reserved) || value.used + value.reserved > value.limit ||
      (value.unit === 'currency_minor' ? typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency) : value.currency !== null) ||
      !plain(value.period) || Object.keys(value.period).sort().join() !== 'ends_at,id,starts_at' || !id(value.period.id) ||
      !['starts_at', 'ends_at'].every(key => typeof value.period[key] === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value.period[key]) && Number.isFinite(Date.parse(value.period[key]))) ||
      Date.parse(value.period.ends_at) <= Date.parse(value.period.starts_at)) throw new TypeError('Invalid explicit resource pool boundary, units or accounting');
  return Object.freeze(structuredClone(value));
}

export function assertPoolAllocation(value, pool) {
  pool = assertResourcePool(pool);
  const fields = ['schema_version', 'allocation_id', 'pool_id', 'workspace_id', 'account_id', 'target', 'limit'];
  if (!plain(value) || Object.keys(value).sort().join() !== fields.sort().join() || value.schema_version !== 1 || !id(value.allocation_id) || value.pool_id !== pool.pool_id ||
      value.workspace_id !== pool.workspace_id || value.account_id !== pool.account_id || !integer(value.limit) || value.limit > pool.limit ||
      !plain(value.target) || Object.keys(value.target).sort().join() !== 'id,type' || !['project', 'team', 'collection'].includes(value.target.type) || !id(value.target.id)) throw new TypeError('Pool allocation crosses its owning account, workspace or explicit limit');
  return Object.freeze(structuredClone(value));
}

// Pure revision proposal. The owning writer must condition its atomic commit
// on the full prior record and retain an idempotency receipt in that commit.
export function proposePoolReservation(pool, amount, {workspaceId, accountId, now = Date.now()} = {}) {
  pool = assertResourcePool(pool);
  if (pool.status !== 'active' || pool.workspace_id !== workspaceId || pool.account_id !== accountId || !integer(amount) || amount < 1 ||
      now < Date.parse(pool.period.starts_at) || now >= Date.parse(pool.period.ends_at) || !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(pool.used + pool.reserved + amount) || pool.used + pool.reserved + amount > pool.limit) throw new TypeError('No current capacity in the selected resource pool');
  return assertResourcePool({...pool, reserved: pool.reserved + amount, revision: pool.revision + 1});
}
