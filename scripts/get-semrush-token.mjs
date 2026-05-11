/**
 * Semrush OAuth Device Authorization flow — interactive CLI.
 *
 * Run:   node scripts/get-semrush-token.mjs
 *
 * 1. Hits Semrush to get a device_code + user_code + verification URL.
 * 2. Prints the URL and code; you approve in a browser while signed into Semrush.
 * 3. Polls for the access token; prints it when approval lands.
 *
 * Paste the printed values into .env.local and restart `npm run dev`.
 */

const OAUTH_BASE = "https://oauth.semrush.com";
const SCOPE = process.env.SEMRUSH_OAUTH_SCOPE || "user.id";

async function postForm(path, params) {
  const res = await fetch(`${OAUTH_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

(async () => {
  // 1. Request a device code
  const init = await postForm("/dag/device/code", { scope: SCOPE });
  if (init.status !== 200 || !init.body?.device_code) {
    console.error(`Device code request failed (HTTP ${init.status}):`);
    console.error(init.body);
    process.exit(1);
  }

  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    expires_in = 600,
    interval = 5,
  } = init.body;

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("  Approve this request in your browser:");
  console.log("");
  console.log(`  URL:  ${verification_uri_complete || verification_uri}`);
  console.log(`  Code: ${user_code}`);
  console.log("");
  console.log("  Make sure you're signed into the Semrush account that owns");
  console.log("  the Listing Management subscription.");
  console.log("────────────────────────────────────────────────────────────");
  console.log("\nWaiting for approval (polling every", interval, "seconds)...");

  // 2. Poll for the access token
  const deadline = Date.now() + expires_in * 1000;
  let pollInterval = interval * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const poll = await postForm("/dag/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code,
    });

    if (poll.body?.access_token) {
      const tok = poll.body;
      console.log("\n✓ Approved.\n");
      console.log("Add these lines to .env.local (replace the existing values):");
      console.log("────────────────────────────────────────────────────────────");
      console.log(`SEMRUSH_BEARER_TOKEN=${tok.access_token}`);
      if (tok.refresh_token) {
        console.log(`SEMRUSH_REFRESH_TOKEN=${tok.refresh_token}`);
      }
      console.log("────────────────────────────────────────────────────────────");
      console.log(
        `\nAccess token: ${tok.access_token.length} chars, expires in ${tok.expires_in}s` +
          (tok.token_type ? `, type "${tok.token_type}"` : "")
      );
      if (tok.refresh_token) {
        console.log(
          "Refresh token captured — once you set SEMRUSH_REFRESH_TOKEN, lib/semrush.js"
        );
        console.log("will auto-refresh expired access tokens on 401.");
      }
      console.log("\nThen restart `npm run dev` and re-run scripts/test-semrush-api.mjs.");
      process.exit(0);
    }

    const err = poll.body?.error;
    if (err === "authorization_pending") {
      process.stdout.write(".");
      continue;
    }
    if (err === "slow_down") {
      pollInterval += 5000;
      process.stdout.write("(slowing down)");
      continue;
    }
    if (err === "access_denied") {
      console.error("\nApproval was denied in the browser. Aborting.");
      process.exit(1);
    }
    if (err === "expired_token") {
      console.error("\nDevice code expired before approval. Run the script again.");
      process.exit(1);
    }

    console.error(`\nUnexpected response (HTTP ${poll.status}):`);
    console.error(poll.body);
    process.exit(1);
  }

  console.error("\nTimed out waiting for approval. Run the script again.");
  process.exit(1);
})();
