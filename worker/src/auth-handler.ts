// auth-handler.ts
import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  addApprovedClient,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  sanitizeText,
  validateCSRFToken,
} from "./workers-oauth-utils";

export type Props = {
  authenticatedAt: string;
};

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };
const app = new Hono<{ Bindings: Bindings }>();

app.get("/authorize", async (c) => {
  console.log("Incoming /authorize URL:", c.req.raw.url);
  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (error: any) {
    return c.text(`Invalid authorization request: ${error.message}`, 400);
  }

  const { clientId } = oauthReqInfo;
  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  if (
    await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)
  ) {
    return completeAndRedirect(c, oauthReqInfo);
  }

  const existingToken = getExistingCsrfToken(c.req.raw);
  const { token: csrfToken, setCookie } = existingToken
    ? {
        token: existingToken,
        setCookie: `__Host-CSRF_TOKEN=${existingToken}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
      }
    : generateCSRFProtection();

  const client = await c.env.OAUTH_PROVIDER.lookupClient(clientId);
  const encodedState = btoa(JSON.stringify({ oauthReqInfo }));

  return renderPassphraseDialog({
    clientName: client?.clientName
      ? sanitizeText(client.clientName)
      : "Unknown MCP Client",
    csrfToken,
    encodedState,
    setCookie,
  });
});

function getExistingCsrfToken(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const csrfCookie = cookies.find((c) => c.startsWith("__Host-CSRF_TOKEN="));
  return csrfCookie ? csrfCookie.substring("__Host-CSRF_TOKEN=".length) : null;
}

app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();
    validateCSRFToken(formData, c.req.raw);

    const encodedState = formData.get("state");
    if (!encodedState || typeof encodedState !== "string") {
      return c.text("Missing state in form data", 400);
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch (_e) {
      return c.text("Invalid state data", 400);
    }
    if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
      return c.text("Invalid request", 400);
    }

    const submitted = formData.get("passphrase");
    if (
      typeof submitted !== "string" ||
      !(await passphraseMatches(submitted, c.env.ACCESS_PASSPHRASE))
    ) {
      return c.text("Incorrect passphrase", 401);
    }

    const approvedClientCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    );

    return completeAndRedirect(c, state.oauthReqInfo, approvedClientCookie);
  } catch (error: any) {
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    console.error("POST /authorize error:", error);
    return c.text(`Internal server error: ${error.message}`, 500);
  }
});

async function completeAndRedirect(
  c: Context<{ Bindings: Bindings }>,
  oauthReqInfo: AuthRequest,
  setCookie?: string,
) {
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    metadata: { label: "search-mcp user" },
    props: { authenticatedAt: new Date().toISOString() } satisfies Props,
    request: oauthReqInfo,
    scope: oauthReqInfo.scope,
    userId: "owner", // single-user server — one fixed identity for every approved session
  });

  const headers = new Headers({ Location: redirectTo });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(null, { status: 302, headers });
}

// Hashes both sides before comparing, rather than a raw `===` on the plain
// strings — same idiom this file's neighbor already uses for the session
// cookie, and it avoids leaking timing information about how many leading
// characters of a guess happened to match.
async function passphraseMatches(
  submitted: string,
  expected: string,
): Promise<boolean> {
  const hash = async (s: string) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(s),
    );
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };
  return (await hash(submitted)) === (await hash(expected));
}

function renderPassphraseDialog(options: {
  clientName: string;
  csrfToken: string;
  encodedState: string;
  setCookie: string;
}): Response {
  const { clientName, csrfToken, encodedState, setCookie } = options;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>search-mcp | Authorization Request</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f9fafb; margin: 0; }
    .card { max-width: 420px; margin: 3rem auto; background: #fff; border-radius: 8px; box-shadow: 0 8px 36px 8px rgba(0,0,0,0.1); padding: 2rem; }
    h1 { font-size: 1.2rem; margin: 0 0 1rem; }
    input[type=password] { width: 100%; padding: 0.6rem; box-sizing: border-box; border: 1px solid #e5e7eb; border-radius: 6px; margin: 0.5rem 0 1.5rem; font-size: 1rem; }
    .actions { display: flex; justify-content: flex-end; }
    button { padding: 0.6rem 1.2rem; border-radius: 6px; border: none; font-size: 1rem; cursor: pointer; background: #0070f3; color: #fff; }
  </style>
</head>
<body>
  <div class="card">
    <h1><strong>${clientName}</strong> is requesting access</h1>
    <form method="post" action="/authorize">
      <input type="hidden" name="state" value="${encodedState}">
      <input type="hidden" name="csrf_token" value="${csrfToken}">
      <label for="passphrase">Passphrase</label>
      <input type="password" id="passphrase" name="passphrase" autofocus>
      <div class="actions"><button type="submit">Approve</button></div>
    </form>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": setCookie,
      "X-Frame-Options": "DENY",
    },
  });
}

export { app as AuthHandler };
