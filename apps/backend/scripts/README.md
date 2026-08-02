# Backend scripts

Local-only maintenance and diagnostic tools. Not shipped in the production
image. Read the script before running it: `test-email-pipeline.ts` writes a
test row to the configured database and sends a real email. The Retell
signature diagnostic does not touch the DB; its optional network call is the
ngrok inspector at `127.0.0.1:4040`.

## `diagnose-retell-signature.ts`

Given a captured Retell webhook (`X-Retell-Signature` header + raw body),
does two things:

1. Tries every plausible combination of `{signed-material scheme, digest
   encoding}` with `RETELL_API_KEY` as the HMAC secret and reports which
   ones, if any, reproduce the digest in the header.
2. Calls the **official `retell-sdk#verify`** on the exact same capture
   and prints its verdict on a dedicated `sdk` row of the table.

**The SDK verdict is the ground truth.** The manual grid remains for
comparison — if the SDK accepts something no manual scheme reproduces,
it means Retell is signing with a scheme we have not enumerated (and
the SDK is silently keeping up). Use the diagnostic to spot those
drifts, not to make production decisions.

### RECOMMENDED — `--capture-from-ngrok`

This is now the default recommendation. It eliminates the "manually
reconstructed capture is off by one bit" trap that spawned the whole
SDK migration.

```bash
# 1. Start the backend and ngrok.
npm run dev            # in one terminal, from apps/backend
ngrok http 3000        # in another terminal

# 2. Trigger a webhook (Retell dashboard test call, or a real call).

# 3. Run the diagnostic. It fetches the last request seen by ngrok
#    at http://127.0.0.1:4040/api/requests/http, decodes the raw
#    base64 body, and analyses those EXACT bytes.
npm run diag:retell -- --capture-from-ngrok
```

Defensive on failure modes: if ngrok is not running, or the API shape
changed, or no request has been captured yet, the script tells you
exactly what to do — never a stack trace.

### Fallback — manual capture

If you cannot use ngrok (working from a support ticket someone else
pasted, or you want to compare the current state to an old capture),
the older modes still work:

**1. Positional JSON capture:**

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

**3. `--body-file` — highest fidelity of the manual modes:**

```bash
# From ngrok's Raw tab, save the body bytes to body.raw
npm run diag:retell -- \
  --header "v=1785450205245,d=4def1fb4..." \
  --body-file body.raw
```

The body is read as raw bytes — no JSON round-trip, no whitespace
rewriting, no line-ending translation. Still less trustworthy than
`--capture-from-ngrok` (nothing beats the actual API), but a lot
better than copy/pasting text.

**4. Stdin — pipe a JSON capture:**

```bash
cat capture.json | npm run diag:retell
```

### Capturing the header and body via ngrok (manual, for the fallback modes)

If you need to build a JSON capture by hand:

1. Start the backend and ngrok as usual (`npm run dev`, then
   `ngrok http 3000`).
2. Trigger a webhook.
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
   HMAC will no longer match — that is exactly why `--capture-from-ngrok`
   is now the recommended flow.

### Interpreting the output

- **SDK verdict = OK**: verification passes. If your webhook is still
  returning 401 in production, the issue is elsewhere: check the
  `Retell signature verification via SDK, secret = RETELL_API_KEY` log
  line at boot, confirm the same `RETELL_API_KEY` is loaded in Jelastic,
  and look at the freshness block below the table (clock skew).

- **SDK verdict = rejected, and no manual row matches**: the secret in
  your `.env.local` almost certainly does not match the one configured
  in the Retell dashboard. Rotate the key and retry. If it still fails
  with a byte-exact capture, contact Retell support.

- **SDK verdict = rejected, but some manual row matches**: rare. Usually
  a timestamp / replay window disagreement — the SDK's own 5-minute
  window may have rejected the capture even though the HMAC is correct.
  Check the freshness block.

- **SDK verdict = OK, but no manual row matches**: Retell is signing
  with a scheme we have not enumerated in the manual grid. That is fine
  — the SDK is the source of truth. If you care about updating the
  grid to reflect current Retell behaviour, add a scheme to `SCHEMES`
  in the script.

- **Zero matches, timestamp OUT of window**: clock skew. Fix the host
  clock (NTP) or increase `RETELL_SIGNATURE_MAX_AGE_SECONDS`
  temporarily for the diagnostic. Note that the SDK enforces its own
  5-minute window internally, so a very stale capture will always be
  rejected regardless of our config.

### Safety notes

- The script NEVER prints the value of any secret. It only shows the
  variable name and length. Its output is meant to be pasted into chat
  or a support ticket.
- No DB access. No outbound HTTP except the localhost ngrok inspector
  when `--capture-from-ngrok` is passed. No file writes outside
  stdout/stderr.
- Exits with code 0 if the SDK verdict is OK (or, when the SDK could
  not be invoked, if at least one manual combination matches); 1
  otherwise — suitable for a smoke check in CI later on.
