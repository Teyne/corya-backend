# Backend scripts

Local-only maintenance and diagnostic tools. Not shipped in the production
image. Nothing here touches the DB or the network.

## `diagnose-retell-signature.ts`

Given a captured Retell webhook (`X-Retell-Signature` header + raw body),
tries every plausible combination of `{secret, signed-material scheme,
digest encoding}` and tells you which one, if any, matches the digest in
the header.

Use it whenever the webhook returns `401` and you can't reproduce Retell's
signature.

### Capturing the header and body via ngrok

1. Start the backend and ngrok as usual (`npm run dev`, then
   `ngrok http 3000`).
2. Trigger a webhook (Retell dashboard test call, or a real call).
3. Open the ngrok inspector at <http://127.0.0.1:4040>.
4. In the left column, click the `POST /webhooks/retell/call-ended`
   request.
5. In the right panel, open the **Request** tab.
6. Under **Headers**, copy the value of `X-Retell-Signature` (starts with
   `v=`).
7. Under **Raw** (not "Body", not "JSON"), the **Raw** sub-tab shows the
   exact bytes ngrok received. Use "Save" (or select-all + copy) to
   preserve those bytes untouched. If you copy from the pretty-printed
   **JSON** view instead, you will silently re-encode whitespace and the
   HMAC will no longer match — that's the whole reason `--body-file`
   exists.

### Four invocation modes

**1. Positional JSON capture** — quickest for chat/ticket paste-ability:

```bash
# capture.json = { "header": "v=1785...,d=4def...", "body": "{\"event\":\"call_analyzed\",...}" }
npm run diag:retell -- capture.json
```

**2. Explicit `--header` / `--body` flags:**

```bash
npm run diag:retell -- \
  --header "v=1785450205245,d=4def1fb4..." \
  --body '{"event":"call_analyzed","call":{"call_id":"..."}}'
```

**3. `--body-file` — RECOMMENDED when the result is ambiguous:**

```bash
# Save the raw body from ngrok's "Raw" tab into body.raw
npm run diag:retell -- \
  --header "v=1785450205245,d=4def1fb4..." \
  --body-file body.raw
```

The body is read as raw bytes — no JSON round-trip, no whitespace
rewriting, no line-ending translation. If your first attempt with mode 1
or 2 says "no match" but you're confident the secret is correct, retry
with `--body-file`. A single extra space or a `\r\n` -> `\n` conversion
is enough to break HMAC-SHA256.

**4. Stdin** — pipe a JSON capture:

```bash
cat capture.json | npm run diag:retell
```

### Interpreting the output

- **Exactly one row matches, with `secret=webhook_secret, scheme=ts.body,
  encoding=hex-lower`** — this is the production configuration.
  Everything is fine cryptographically; if you were still getting 401,
  investigate the timestamp freshness block (clock skew on ngrok/backend
  host) or the header parsing.

- **A row matches with `secret=api_key`** — the Retell agent is signing
  with the API key, not the webhook secret. Either set
  `RETELL_WEBHOOK_SECRET` to the value currently in `RETELL_API_KEY`, or
  rotate the webhook secret in the Retell dashboard and copy it into
  `.env.local`. The prod code already prefers `webhook_secret` and falls
  back to `api_key`, so if only `api_key` is set, verification will
  already work — but you should not be surprised by which one you're
  actually using.

- **A row matches with `scheme=body` (no timestamp prefix)** — an older
  Retell signing convention. Speak to Retell support and confirm which
  scheme is active on your workspace; do NOT change our production code
  to match without written confirmation.

- **A row matches with `encoding=base64`** — same as above, unusual for
  Retell. Confirm with support before adapting the code.

- **Zero matches, timestamp in window** — the secret in your `.env.local`
  does not match the one configured in the Retell dashboard. Rotate and
  recopy. If it still fails, retry with `--body-file` in case the body
  was reformatted between capture and diagnosis.

- **Zero matches, timestamp OUT of window** — clock skew. Even if the
  HMAC were correct, the production code would reject the webhook. Fix
  the host clock (NTP) or increase `RETELL_SIGNATURE_MAX_AGE_SECONDS`
  temporarily for the diagnostic.

- **Multiple matches** — this is astronomically improbable for
  HMAC-SHA256. It means the script is buggy or two secrets are
  identical. Investigate the script, do NOT declare the webhook fixed.

### Safety notes

- The script NEVER prints the value of any secret. It only shows the
  variable name and length. Its output is meant to be pasted into chat
  or a support ticket.
- No DB access. No outbound HTTP. No file writes outside stdout/stderr.
- Exits with code 0 if at least one combination matches, 1 otherwise —
  suitable for a smoke check in CI later on.
