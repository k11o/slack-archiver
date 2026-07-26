let cachedJwks;

function resolveClaimPair(claims, customKey, namespacedKey) {
  const custom = claims?.[customKey];
  const namespaced = claims?.[namespacedKey];
  if (custom && namespaced && custom !== namespaced) return null;
  return custom || namespaced || null;
}

function resolveTeamId(claims) {
  return resolveClaimPair(
    claims,
    'custom:slack_team_id',
    'https://slack.com/team_id',
  );
}

function resolveUserId(claims) {
  return resolveClaimPair(
    claims,
    'custom:slack_user_id',
    'https://slack.com/user_id',
  );
}

function parseAllowedTeamIds(value) {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.filter(Boolean));
  return new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean));
}

function isAllowedTeam({ teamId, allowedSlackTeamIds }) {
  const allowed = parseAllowedTeamIds(allowedSlackTeamIds);
  return allowed.size === 0 || allowed.has(teamId);
}

async function verifyCognitoJwt(event) {
  const authorization = event.headers?.authorization || event.headers?.Authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error('missing bearer token'), { statusCode: 401 });

  const issuer = process.env.COGNITO_ISSUER;
  const audience = process.env.COGNITO_CLIENT_ID;
  if (!issuer || !audience) {
    throw Object.assign(new Error('missing cognito configuration'), { statusCode: 500 });
  }

  const { createRemoteJWKSet, jwtVerify } = await import('jose');
  if (!cachedJwks) cachedJwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  try {
    const result = await jwtVerify(match[1], cachedJwks, { issuer, audience });
    return result.payload;
  } catch (error) {
    throw Object.assign(error, { statusCode: 401 });
  }
}

async function authenticateWebRequest({
  event,
  allowedSlackTeamIds,
  verifyAuth = verifyCognitoJwt,
  requireUser = false,
}) {
  let claims;
  try {
    claims = await verifyAuth(event);
  } catch (error) {
    return { error: 'unauthorized', statusCode: error.statusCode || 401 };
  }

  const teamId = resolveTeamId(claims);
  const userId = resolveUserId(claims);
  if (!teamId || !isAllowedTeam({ teamId, allowedSlackTeamIds })) {
    return { error: 'forbidden_workspace', statusCode: 403 };
  }
  if (requireUser && !userId) {
    return { error: 'forbidden_user', statusCode: 403 };
  }
  return { claims, teamId, userId };
}

module.exports = {
  authenticateWebRequest,
  isAllowedTeam,
  parseAllowedTeamIds,
  resolveTeamId,
  resolveUserId,
  verifyCognitoJwt,
};
