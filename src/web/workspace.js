function decodeIdToken(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const binary = typeof atob === "function"
      ? atob(base64)
      : Buffer.from(base64, "base64").toString("binary");
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    return null;
  }
}

function resolveClaimPair(claims, customKey, namespacedKey) {
  if (!claims) return "";
  const custom = claims[customKey] || "";
  const namespaced = claims[namespacedKey] || "";
  if (custom && namespaced && custom !== namespaced) return "";
  return custom || namespaced || "";
}

function formatWorkspaceLabel(idToken) {
  const claims = idToken ? decodeIdToken(idToken) : null;
  const teamId = resolveClaimPair(claims, "custom:slack_team_id", "https://slack.com/team_id");
  const teamName = resolveClaimPair(claims, "custom:slack_team_name", "https://slack.com/team_name");
  if (!teamId) return "Slack workspace account required";
  return teamName ? teamName + " (" + teamId + ")" : teamId;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { decodeIdToken, resolveClaimPair, formatWorkspaceLabel };
}
