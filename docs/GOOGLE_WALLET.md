# Google Wallet setup

The pass page shows **Add to Google Wallet** on Android and desktop (not on iPhone). It saves an event ticket with
the event name, date, venue, attendee name and the **same QR code** as the pass, so door scanning is unchanged.

## How it works

1. The attendee taps the button. The browser sends the pass token to the `google-wallet` Edge Function.
2. The function looks up the pass with `public.wallet_pass_data()`. That function can only be called by the
   service role, and it refuses unknown or revoked passes.
3. The function signs a "save to wallet" JWT with your Google service-account key (RS256, Web Crypto, no
   dependencies) and returns `https://pay.google.com/gp/v/save/<jwt>`.
4. Google creates the ticket class (one per event) and the ticket (one per pass version). Reissuing a pass
   creates a new wallet ticket, and the old one no longer scans as valid.

The signing key exists only as a Supabase function secret. It is never in the website, in git, or in chat.

## One-time setup (owner)

1. **Issuer account:** open the [Google Pay & Wallet Console](https://pay.google.com/business/console) → Google
   Wallet API → create an issuer account. Note the **Issuer ID** (a long number).
2. **Service account:** in [Google Cloud Console](https://console.cloud.google.com), create (or pick) a project.
   - Go to *APIs & Services → Library*, search for **Google Wallet API**, and click **Enable**.
   - Go to *IAM & Admin → Service accounts* → **Create service account** (e.g. `passsystem-wallet`). No roles are
     needed.
   - Open it → *Keys* → **Add key → JSON**. A file downloads. Keep it private.
3. **Link them:** back in the Wallet Console → *Users* → **Invite** the service account email (from the JSON
   file, `…@….iam.gserviceaccount.com`) with the *Developer* role.
4. **Store the secrets:** in the Supabase dashboard → PassSystem → *Edge Functions → Secrets*, add:

   | Name | Value |
   | --- | --- |
   | `GOOGLE_WALLET_ISSUER_ID` | the Issuer ID |
   | `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL` | `client_email` from the JSON file |
   | `GOOGLE_WALLET_PRIVATE_KEY` | `private_key` from the JSON file. Paste it whole; the `\n` line breaks are fine. |
   | `PUBLIC_SITE_URL` | `https://passsystem-phi.vercel.app` |
   | `GOOGLE_WALLET_ISSUER_NAME` | optional, shown on the ticket, e.g. your organisation's name |

5. **Deploy the function** (Claude does this; it needs the Supabase token's Edge Functions permission) and set
   `VITE_GOOGLE_WALLET=1` in Vercel so the button appears.
6. **Test mode:** until Google approves your issuer for publishing, only accounts added as test users in the
   Wallet Console can save passes. Request publishing access in the console when you're ready. Google reviews
   the ticket design and the button.

## Before requesting publishing access

- Google's brand guidelines require the official **Add to Google Wallet** button artwork. The current button is
  a close stand-in. Swap in the official SVG from Google's brand assets (`src/components/GoogleWalletButton.tsx`).
- Optional later: mark wallet tickets as *used* after admission. That needs the Wallet REST API with OAuth from
  the Edge Function.

## Tests

- `supabase/functions/_shared/googleWallet.test.ts`: JWT claims, RS256 signature verified with the public key,
  IDs, PEM parsing.
- `tests/integration/wallet.test.ts`: the real Edge Function on the local stack with a throwaway key
  (`scripts/gen-test-wallet-env.mjs`). Covers the signed link, unknown, revoked and malformed requests, and the
  RPC privileges.
- E2E: Android is redirected to a signed `pay.google.com` link; the button is hidden on iPhone.
