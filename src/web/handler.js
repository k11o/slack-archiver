const fs = require('node:fs');
const path = require('node:path');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const {
  formatSlackMessageText,
  loadMessageContext,
  searchMessages,
} = require('../search/handler');
const {
  authenticateWebRequest,
  resolveTeamId,
  verifyCognitoJwt,
} = require('./auth');
const { formatWorkspaceLabel } = require('./workspace');

const workspaceScript = fs.readFileSync(path.join(__dirname, 'workspace.js'), 'utf8');

const ssm = new SSMClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const botTokenCache = new Map();
const userCache = new Map();
const channelCache = new Map();

async function getBotToken({ teamId } = {}) {
  const paramName = getBotTokenParamName(teamId);
  if (botTokenCache.has(paramName)) return botTokenCache.get(paramName);
  const result = await ssm.send(new GetParameterCommand({
    Name: paramName,
    WithDecryption: true,
  }));
  botTokenCache.set(paramName, result.Parameter.Value);
  return result.Parameter.Value;
}

function getBotTokenParamName(teamId) {
  if (!teamId) throw new Error('missing Slack team ID');
  const prefix = process.env.SLACK_BOT_TOKEN_PARAM_PREFIX || '/slack-archiver/workspaces/';
  return `${prefix.replace(/\/?$/, '/')}${teamId}/slack-bot-token`;
}

exports.page = async () => html(renderPage({
  cognitoDomain: process.env.COGNITO_DOMAIN,
  clientId: process.env.COGNITO_CLIENT_ID,
  redirectUri: process.env.COGNITO_REDIRECT_URI,
  searchUrl: process.env.WEB_SEARCH_URL,
  channelsUrl: process.env.WEB_CHANNELS_URL,
  exportsUrl: process.env.WEB_EXPORTS_URL,
}));

function createSearchHandler({
  allowedSlackTeamIds,
  getBotToken: loadBotToken,
  ddbSend,
  verifyAuth = verifyCognitoJwt,
  search = searchMessages,
  loadContext = loadMessageContext,
  formatResult = formatWebResult,
}) {
  return async (event) => {
    const auth = await authenticateWebRequest({
      event,
      allowedSlackTeamIds,
      verifyAuth,
    });
    if (auth.error) return json({ error: auth.error }, auth.statusCode);
    const { teamId } = auth;

    const query = String(event.queryStringParameters?.q || '').trim();
    if (!query) return json({ results: [] });

    const botToken = await loadBotToken({ teamId });
    const hits = await search({ query, teamId, ddbSend });

    const results = [];
    for (const hit of hits) {
      const context = await loadContext({ message: hit, ddbSend });
      results.push(await formatResult({ botToken, teamId, hit, context }));
    }

    return json({ results });
  };
}

async function formatWebResult({ botToken, teamId, hit, context }) {
  const userNames = await loadUserNames({ botToken, teamId, messages: context });
  const channelName = await resolveChannelName({ botToken, teamId, channelId: hit.channel_id });

  return {
    channel_id: hit.channel_id,
    channel_name: channelName,
    ts: hit.ts,
    time: slackTsToIso(hit.ts),
    user_id: hit.user_id,
    user_name: userNames.get(hit.user_id) || hit.user_id || '(unknown user)',
    text: formatSlackMessageText(hit.text || '', userNames),
    context: context.map((message) => ({
      channel_id: message.channel_id,
      channel_name: channelName,
      ts: message.ts,
      time: slackTsToIso(message.ts),
      user_id: message.user_id,
      user_name: userNames.get(message.user_id) || message.user_id || '(unknown user)',
      text: formatSlackMessageText(message.text || '', userNames),
      is_hit: message.pk === hit.pk && message.sk === hit.sk,
    })),
  };
}

async function loadUserNames({ botToken, teamId, messages }) {
  const ids = new Set();
  for (const message of messages) {
    if (message.user_id) ids.add(message.user_id);
    for (const mentioned of String(message.text || '').matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)) {
      ids.add(mentioned[1]);
    }
  }

  const entries = await Promise.all([...ids].map(async (userId) => [
    userId,
    await resolveUserName({ botToken, teamId, userId }),
  ]));
  return new Map(entries);
}

async function resolveUserName({ botToken, teamId, userId }) {
  if (!userId) return '(unknown user)';
  const cacheKey = `${teamId || ''}:${userId}`;
  if (userCache.has(cacheKey)) return userCache.get(cacheKey);

  const payload = await slackApi({
    botToken,
    method: 'users.info',
    params: { user: userId },
  });
  const name = payload.user?.profile?.display_name_normalized
    || payload.user?.profile?.display_name
    || payload.user?.profile?.real_name_normalized
    || payload.user?.profile?.real_name
    || payload.user?.real_name
    || payload.user?.name
    || userId;
  const sanitized = sanitizeDisplayName(name);
  userCache.set(cacheKey, sanitized);
  return sanitized;
}

async function resolveChannelName({ botToken, teamId, channelId }) {
  if (!channelId) return '(unknown channel)';
  const cacheKey = `${teamId || ''}:${channelId}`;
  if (channelCache.has(cacheKey)) return channelCache.get(cacheKey);

  const payload = await slackApi({
    botToken,
    method: 'conversations.info',
    params: { channel: channelId },
  });
  const name = payload.channel?.name ? `#${payload.channel.name}` : channelId;
  channelCache.set(cacheKey, name);
  return name;
}

async function slackApi({ botToken, method, params }) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${botToken}` },
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) return {};
  return payload;
}

function slackTsToIso(ts) {
  const seconds = Number.parseFloat(ts || '0');
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function sanitizeDisplayName(value) {
  return String(value || '')
    .replace(/^@+/, '')
    .replace(/[<>]/g, '')
    .trim() || '(unknown user)';
}

function renderPage(config) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Slack Archiver</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background: #f7f8fb; }
    .app-shell { max-width: 1120px; }
    .result-card { border-left: 4px solid #0d6efd; }
    .context-hit { background: #fff8df; }
    .message-text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .muted-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
  <main class="container app-shell py-4">
    <div class="d-flex align-items-center justify-content-between gap-3 mb-4">
      <div>
        <h1 class="h3 mb-1">Slack Archiver</h1>
        <p class="text-secondary mb-0" id="workspaceLabel">Slack workspace account required</p>
      </div>
      <button id="logoutButton" class="btn btn-outline-secondary d-none" type="button">Logout</button>
    </div>

    <section id="signedOut" class="card shadow-sm">
      <div class="card-body p-4">
        <h2 class="h5">Sign in required</h2>
        <p class="text-secondary">Slack workspace authentication is required before searching archived messages.</p>
        <button id="loginButton" class="btn btn-primary" type="button">Sign in with Slack</button>
      </div>
    </section>

    <section id="signedIn" class="d-none">
      <form id="searchForm" class="input-group mb-3">
        <input id="queryInput" class="form-control form-control-lg" type="search" placeholder="Search archived Slack messages" autocomplete="off">
        <button class="btn btn-primary btn-lg" type="submit">Search</button>
      </form>
      <div id="status" class="text-secondary mb-3"></div>
      <div id="results" class="vstack gap-3"></div>

      <section class="card shadow-sm mt-4">
        <div class="card-body">
          <h2 class="h5">Export channel messages</h2>
          <p class="text-secondary">
            Create a CSV containing every archived human message in one public channel.
            Export files expire after 24 hours.
          </p>
          <form id="exportForm" class="row g-2 align-items-end">
            <div class="col-md-6">
              <label class="form-label" for="channelSelect">Public channel</label>
              <select id="channelSelect" class="form-select">
                <option value="">Loading channels...</option>
              </select>
            </div>
            <div class="col-md-4">
              <label class="form-label" for="channelIdInput">Or archived channel ID</label>
              <input id="channelIdInput" class="form-control muted-mono" type="text" placeholder="C0123456789" pattern="[A-Z0-9]{2,}">
            </div>
            <div class="col-md-2 d-grid">
              <button id="exportButton" class="btn btn-outline-primary" type="submit">Create CSV</button>
            </div>
          </form>
          <div id="exportStatus" class="text-secondary mt-3"></div>
          <a id="exportDownload" class="btn btn-success mt-2 d-none" href="#">Download CSV</a>
        </div>
      </section>
    </section>
  </main>

  <script>
    ${workspaceScript}
  </script>
  <script>
    const config = ${JSON.stringify(config)};
    const tokenKey = "slackArchiverTokens";
    const verifierKey = "slackArchiverPkceVerifier";
    const stateKey = "slackArchiverOauthState";

    const signedOut = document.getElementById("signedOut");
    const signedIn = document.getElementById("signedIn");
    const loginButton = document.getElementById("loginButton");
    const logoutButton = document.getElementById("logoutButton");
    const searchForm = document.getElementById("searchForm");
    const queryInput = document.getElementById("queryInput");
    const statusEl = document.getElementById("status");
    const resultsEl = document.getElementById("results");
    const exportForm = document.getElementById("exportForm");
    const channelSelect = document.getElementById("channelSelect");
    const channelIdInput = document.getElementById("channelIdInput");
    const exportButton = document.getElementById("exportButton");
    const exportStatus = document.getElementById("exportStatus");
    const exportDownload = document.getElementById("exportDownload");
    let channelsLoaded = false;

    loginButton.addEventListener("click", startLogin);
    logoutButton.addEventListener("click", logout);
    searchForm.addEventListener("submit", search);
    exportForm.addEventListener("submit", startExport);

    init();

    async function init() {
      const params = new URLSearchParams(window.location.search);
      if (params.has("code")) {
        const expectedState = sessionStorage.getItem(stateKey);
        const returnedState = params.get("state");
        sessionStorage.removeItem(stateKey);
        if (!expectedState || expectedState !== returnedState) {
          statusEl.textContent = "Authentication failed. Please sign in again.";
          history.replaceState({}, document.title, "/web");
          renderAuthState();
          return;
        }
        await finishLogin(params.get("code"));
        history.replaceState({}, document.title, "/web");
      }
      renderAuthState();
    }

    function renderAuthState() {
      const tokens = getTokens();
      const authed = Boolean(tokens?.id_token);
      signedOut.classList.toggle("d-none", authed);
      signedIn.classList.toggle("d-none", !authed);
      logoutButton.classList.toggle("d-none", !authed);
      renderWorkspaceLabel(tokens?.id_token);
      if (authed && !channelsLoaded) loadChannels();
    }

    function renderWorkspaceLabel(idToken) {
      const label = document.getElementById("workspaceLabel");
      const text = formatWorkspaceLabel(idToken);
      label.textContent = text;
      const authed = text !== "Slack workspace account required";
      label.classList.toggle("text-secondary", !authed);
      label.classList.toggle("text-primary", authed);
      label.classList.toggle("fw-semibold", authed);
    }

    async function startLogin() {
      const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      sessionStorage.setItem(verifierKey, verifier);
      const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      sessionStorage.setItem(stateKey, state);
      const challenge = await sha256Base64Url(verifier);
      const url = new URL(config.cognitoDomain + "/oauth2/authorize");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("state", state);
      url.searchParams.set("identity_provider", "Slack");
      window.location.href = url.toString();
    }

    async function finishLogin(code) {
      const verifier = sessionStorage.getItem(verifierKey);
      if (!verifier) throw new Error("Missing PKCE verifier");
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code,
        redirect_uri: config.redirectUri,
        code_verifier: verifier,
      });
      const response = await fetch(config.cognitoDomain + "/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) throw new Error("Token exchange failed");
      localStorage.setItem(tokenKey, JSON.stringify(await response.json()));
      sessionStorage.removeItem(verifierKey);
    }

    async function search(event) {
      event.preventDefault();
      const query = queryInput.value.trim();
      if (!query) return;
      const tokens = getTokens();
      statusEl.textContent = "Searching...";
      resultsEl.innerHTML = "";
      const response = await fetch(config.searchUrl + "?q=" + encodeURIComponent(query), {
        headers: { authorization: "Bearer " + tokens.id_token },
      });
      if (response.status === 401 || response.status === 403) {
        statusEl.textContent = "Authentication failed. Please sign in again.";
        return;
      }
      const payload = await response.json();
      renderResults(payload.results || []);
    }

    function renderResults(results) {
      statusEl.textContent = results.length ? results.length + " result(s)" : "No messages found.";
      resultsEl.innerHTML = results.map((result) => {
        const context = result.context.map((message) => {
          const rowClass = message.is_hit ? "context-hit" : "";
          return '<div class="p-2 border-top ' + rowClass + '">' +
            '<div class="small text-secondary">' + escapeHtml(formatTime(message.time)) + ' · ' + escapeHtml(message.user_name) + '</div>' +
            '<div class="message-text">' + escapeHtml(message.text) + '</div>' +
          '</div>';
        }).join("");
        return '<article class="card shadow-sm result-card">' +
          '<div class="card-header bg-white">' +
            '<div class="fw-semibold">' + escapeHtml(result.channel_name) + '</div>' +
            '<div class="small text-secondary">' + escapeHtml(result.user_name) + ' · ' + escapeHtml(formatTime(result.time)) + ' · <span class="muted-mono">' + escapeHtml(result.ts) + '</span></div>' +
          '</div>' +
          '<div class="card-body">' + context + '</div>' +
        '</article>';
      }).join("");
    }

    async function loadChannels() {
      channelsLoaded = true;
      let response;
      try {
        response = await fetch(config.channelsUrl, { headers: authHeaders() });
      } catch {
        showChannelIdFallback();
        return;
      }
      if (response.status === 401 || response.status === 403) {
        exportStatus.textContent = "Authentication failed. Please sign in again.";
        return;
      }
      if (!response.ok) {
        showChannelIdFallback();
        return;
      }
      const payload = await response.json();
      channelSelect.innerHTML = '<option value="">Select a channel</option>';
      for (const channel of payload.channels || []) {
        const option = document.createElement("option");
        option.value = channel.id;
        option.dataset.name = channel.name;
        option.textContent = "#" + channel.name + (channel.is_archived ? " (archived)" : "");
        channelSelect.appendChild(option);
      }
    }

    function showChannelIdFallback() {
      exportStatus.textContent = "Could not load Slack channels. You can enter a channel ID directly.";
      channelSelect.innerHTML = '<option value="">Select by channel ID below</option>';
    }

    async function startExport(event) {
      event.preventDefault();
      const manualChannelId = channelIdInput.value.trim().toUpperCase();
      const channelId = manualChannelId || channelSelect.value;
      if (!channelId) {
        exportStatus.textContent = "Select a channel or enter its channel ID.";
        return;
      }
      const selected = channelSelect.selectedOptions[0];
      const channelName = manualChannelId
        ? channelId
        : selected?.dataset.name || channelId;
      exportButton.disabled = true;
      exportDownload.classList.add("d-none");
      exportStatus.textContent = "Starting export...";
      let response;
      try {
        response = await fetch(config.exportsUrl, {
          method: "POST",
          headers: { ...authHeaders(), "content-type": "application/json" },
          body: JSON.stringify({ channel_id: channelId, channel_name: channelName }),
        });
      } catch {
        exportButton.disabled = false;
        exportStatus.textContent = "Could not reach the export service. Please try again.";
        return;
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        exportButton.disabled = false;
        exportStatus.textContent = exportErrorMessage(payload.error);
        return;
      }
      await pollExport(payload.job.job_id, 0);
    }

    async function pollExport(jobId, retryCount) {
      let response;
      try {
        response = await fetch(config.exportsUrl + "/" + encodeURIComponent(jobId), {
          headers: authHeaders(),
        });
      } catch {
        if (retryCount < 5) {
          exportStatus.textContent = "Waiting to reconnect to the export service...";
          window.setTimeout(() => pollExport(jobId, retryCount + 1), 2000);
        } else {
          exportButton.disabled = false;
          exportStatus.textContent = "Could not check the export. Please try creating it again.";
        }
        return;
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        exportButton.disabled = false;
        exportStatus.textContent = exportErrorMessage(payload.error);
        return;
      }
      const job = payload.job;
      if (job.status === "completed") {
        exportButton.disabled = false;
        exportStatus.textContent = "Exported " + job.message_count + " message(s).";
        exportDownload.href = job.download_url;
        exportDownload.classList.remove("d-none");
        return;
      }
      if (job.status === "failed") {
        exportButton.disabled = false;
        exportStatus.textContent = "Export failed: " + (job.error_message || "unknown error");
        return;
      }
      exportStatus.textContent = job.status === "running" ? "Creating CSV..." : "Export queued...";
      window.setTimeout(() => pollExport(jobId, 0), 2000);
    }

    function authHeaders() {
      return { authorization: "Bearer " + getTokens().id_token };
    }

    function exportErrorMessage(error) {
      if (error === "channel_not_archived") return "No archived messages were found for that channel.";
      if (error === "invalid_channel_id") return "Enter a valid Slack channel ID.";
      if (error === "unauthorized" || error === "forbidden_workspace" || error === "forbidden_user") {
        return "Authentication failed. Please sign in again.";
      }
      return "Could not create the export. Please try again.";
    }

    function logout() {
      localStorage.removeItem(tokenKey);
      const url = new URL(config.cognitoDomain + "/logout");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("logout_uri", window.location.origin + "/web");
      window.location.href = url.toString();
    }

    function getTokens() {
      try { return JSON.parse(localStorage.getItem(tokenKey) || "null"); } catch { return null; }
    }

    function formatTime(value) {
      if (!value) return "unknown time";
      return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
    }

    async function sha256Base64Url(value) {
      const data = new TextEncoder().encode(value);
      const digest = await crypto.subtle.digest("SHA-256", data);
      return base64Url(new Uint8Array(digest));
    }

    function base64Url(bytes) {
      return btoa(String.fromCharCode(...bytes)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    }

    function escapeHtml(value) {
      return String(value || "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]);
    }
  </script>
</body>
</html>`;
}

function html(body) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body,
  };
}

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

exports.renderPage = renderPage;
exports.createSearchHandler = createSearchHandler;
exports.formatWebResult = formatWebResult;
exports.resolveTeamId = resolveTeamId;
exports.search = createSearchHandler({
  allowedSlackTeamIds: process.env.ALLOWED_SLACK_TEAM_IDS,
  getBotToken,
  ddbSend: (command) => ddb.send(command),
});
