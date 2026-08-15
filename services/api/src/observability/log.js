// @ts-check

/**
 * @param {string} level
 * @param {string} message
 * @param {Record<string, unknown>} fields
 */
export function log(level, message, fields = {}) {
  const safe = {...fields};
  delete safe.authorization;
  delete safe.token;
  delete safe.password;
  console.log(JSON.stringify({level, message, ...safe}));
}
