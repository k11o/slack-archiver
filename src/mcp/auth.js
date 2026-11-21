const { isAllowedTeam, parseAllowedTeamIds, resolveTeamId } = require('../web/auth');

const REQUIRED_SCOPE = process.env.MCP_READ_SCOPE || 'slack-archiver/read';
const jwksByIssuer = new Map();

async function verifyCognitoAccessToken({ token, issuer, audience }) {
  if (!issuer || !audience) throw Object.assign(new Error('missing Cognito configuration'), { statusCode: 500 });
  const { createRemoteJWKSet, jwtVerify } = await import('jose');
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    jwksByIssuer.set(issuer, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, { issuer, audience });
  return payload;
}

async function getCognitoUserInfo({ token, cognitoDomain, fetchImpl = fetch }) {
  const response = await fetchImpl(`${cognitoDomain.replace(/\/$/, '')}/oauth2/userInfo`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw Object.assign(new Error('Cognito userinfo request failed'), {
      statusCode: response.status === 401 ? 401 : 503,
    });
  }
  return response.json();
}

function createMcpAuthenticator({
  issuer = process.env.COGNITO_ISSUER,
  clientId = process.env.COGNITO_MCP_CLIENT_ID,
  resource = process.env.MCP_BASE_URL,
  cognitoDomain = process.env.COGNITO_DOMAIN,
  allowedSlackTeamIds = process.env.ALLOWED_SLACK_TEAM_IDS,
  verifyToken = verifyCognitoAccessToken,
  loadUserInfo = getCognitoUserInfo,
} = {}) {
  return async (event) => {
    const authorization = event.headers?.authorization || event.headers?.Authorization || '';
    const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) return { error: 'unauthorized', statusCode: 401 };

    let claims;
    try {
      claims = await verifyToken({ token: match[1], issuer, audience: resource });
    } catch (error) {
      return { error: 'unauthorized', statusCode: error.statusCode || 401 };
    }

    const scopes = String(claims.scope || '').split(/\s+/).filter(Boolean);
    if (claims.token_use !== 'access'
      || claims.client_id !== clientId
      || !scopes.includes('openid')
      || !scopes.includes(REQUIRED_SCOPE)
      || !claims.sub
      || !Number.isFinite(Number(claims.exp))
      || Number(claims.exp) <= Math.floor(Date.now() / 1000)) {
      return { error: 'unauthorized', statusCode: 401 };
    }

    let userInfo;
    try {
      userInfo = await loadUserInfo({ token: match[1], cognitoDomain });
    } catch (error) {
      return { error: 'identity_unavailable', statusCode: error.statusCode || 503 };
    }
    if (!userInfo || userInfo.sub !== claims.sub) {
      return { error: 'unauthorized', statusCode: 401 };
    }

    const teamId = resolveTeamId(userInfo);
    if (!teamId || !/^T[A-Z0-9]+$/.test(teamId) || !isAllowedTeam({
      teamId,
      allowedSlackTeamIds: parseAllowedTeamIds(allowedSlackTeamIds),
    })) {
      return { error: 'forbidden_workspace', statusCode: 403 };
    }

    return {
      teamId,
      authInfo: {
        token: match[1],
        clientId: claims.client_id,
        scopes,
        expiresAt: Number(claims.exp),
        resource: new URL(resource),
        extra: { teamId },
      },
    };
  };
}

module.exports = {
  REQUIRED_SCOPE,
  verifyCognitoAccessToken,
  getCognitoUserInfo,
  createMcpAuthenticator,
};
