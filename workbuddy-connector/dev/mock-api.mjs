// Minimal stand-in for a MemoryLake deployment, at base URL http://127.0.0.1:18765.
// Accepts the test key sk-test-mock, and serves the CLI's browser login: a
// consent page with Approve / Deny links, a token endpoint that checks PKCE,
// and endpoints that create and revoke the keys that login hands out.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const KEY = "sk-test-mock";
const WS = (process.env.MOCK_WORKSPACES || "ws-1:Personal,ws-2:Team Space").split(",").filter(Boolean).map((p) => { const [id, name] = p.split(":"); return { id, name, description: "", metadata: {}, custom_id: "", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }; });
const codes = new Map(); // code -> { challenge, redirectUri }
const tokens = new Set(); // unspent access tokens
const issued = new Map(); // key -> { id, name, revoked }
let nextId = 100;

const readBody = (req) => new Promise((resolve) => { let data = ""; req.on("data", (c) => (data += c)); req.on("end", () => resolve(data)); });
const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
const html = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

createServer(async (req, res) => {
  const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  console.error(req.method, req.url.replace(/([?&](code|state|code_challenge)=)[^&]+/g, "$1…"));
  const url = new URL(req.url, "http://x");

  if (req.method === "GET" && url.pathname === "/oauth2/mcp/authorize") {
    const q = url.searchParams;
    const redirectUri = q.get("redirect_uri") || "";
    const problems = [];
    if (q.get("response_type") !== "code") problems.push("response_type");
    if (q.get("client_id") !== "memorylake-cli") problems.push("client_id");
    if (q.get("scope") !== "memlake:apikey") problems.push("scope");
    if (q.get("code_challenge_method") !== "S256") problems.push("code_challenge_method");
    if (!/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") || "")) problems.push("code_challenge");
    if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri)) problems.push("redirect_uri");
    if (!q.get("state")) problems.push("state");
    if (problems.length) return send(400, `bad authorize request: ${problems.join(", ")}`, "text/plain");
    const code = randomBytes(12).toString("hex");
    codes.set(code, { challenge: q.get("code_challenge"), redirectUri });
    const state = encodeURIComponent(q.get("state"));
    return send(200, `<!doctype html><meta charset="utf-8"><title>Mock consent</title>
      <body style="font:16px system-ui;margin:15vh auto;max-width:30em">
      <h1>Mock MemoryLake consent</h1><p><b>memorylake CLI</b> wants to create an API key in team <b>Mock Team</b>.</p>
      <p><a id="approve" href="${html(`${redirectUri}?code=${code}&state=${state}`)}">Approve</a> ·
      <a id="deny" href="${html(`${redirectUri}?error=access_denied&state=${state}`)}">Deny</a></p></body>`, "text/html; charset=utf-8");
  }

  if (req.method === "POST" && url.pathname === "/oauth2/mcp/token") {
    const form = new URLSearchParams(await readBody(req));
    const entry = codes.get(form.get("code"));
    codes.delete(form.get("code"));
    const challenge = createHash("sha256").update(form.get("code_verifier") || "").digest("base64url");
    if (!entry || form.get("grant_type") !== "authorization_code" || form.get("client_id") !== "memorylake-cli") return send(400, { error: "invalid_grant", error_description: "unknown or used code" });
    if (entry.redirectUri !== form.get("redirect_uri")) return send(400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
    if (entry.challenge !== challenge) return send(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    const token = `at-${randomBytes(12).toString("hex")}`;
    tokens.add(token);
    return send(200, { access_token: token, token_type: "Bearer", expires_in: 300, scope: "memlake:apikey" });
  }

  if (req.method === "POST" && url.pathname === "/oauth2/cli/api-keys") {
    if (!tokens.delete(bearer(req))) return send(401, { error: "invalid_token", error_description: "token unknown or already used" });
    const { name, device } = JSON.parse((await readBody(req)) || "{}");
    const key = `sk-mock-${randomBytes(8).toString("hex")}`;
    const id = String(nextId++);
    issued.set(key, { id, name, revoked: false });
    console.error("  issued key", id, JSON.stringify(name), "device", JSON.stringify(device));
    return send(201, { id, name, key, key_prefix: key.slice(0, 10), expires_at: Math.floor(Date.now() / 1000) + 90 * 86400, tenant_id: "mock-team" });
  }

  if (req.method === "POST" && url.pathname === "/oauth2/cli/api-keys/revoke") {
    const entry = issued.get(bearer(req));
    if (!entry) return send(403, { error: "access_denied", error_description: "not a key created by browser login" });
    entry.revoked = true;
    console.error("  revoked key", entry.id);
    return send(200, {});
  }

  const key = bearer(req);
  if (key !== KEY && !(issued.has(key) && !issued.get(key).revoked)) return send(401, { success: false, message: "service account not found", error_code: "UNAUTHORIZE" });
  if (url.pathname === "/api/v3/workspaces") return send(200, { success: true, data: { items: WS } });
  const one = WS.find((w) => url.pathname === `/api/v3/workspaces/${w.id}`);
  if (one) return send(200, { success: true, data: one });
  send(404, { success: false, message: "not found", error_code: "NOT_FOUND" });
}).listen(Number(process.env.MOCK_PORT || 18765), "127.0.0.1", () => console.error("mock up"));
