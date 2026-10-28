#!/usr/bin/env node
/**
 * Local/CI only: writes supabase/functions/.env with a throwaway RSA key and a
 * dummy issuer so the google-wallet Edge Function can be integration-tested.
 * The matching public key goes to tests/.artifacts/wallet-test-public.pem.
 * Both files are git-ignored. Never use this for a real deployment.
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
mkdirSync('tests/.artifacts', { recursive: true })
writeFileSync(
  'tests/.artifacts/wallet-test-public.pem',
  publicKey.export({ type: 'spki', format: 'pem' }).toString(),
)
writeFileSync(
  'supabase/functions/.env',
  [
    'GOOGLE_WALLET_ISSUER_ID=3388000000099999999',
    // Same shape as the JSON key file downloaded from Google Cloud (single-quoted: kept verbatim).
    `GOOGLE_WALLET_SERVICE_ACCOUNT_JSON='${JSON.stringify({
      type: 'service_account',
      client_email: 'wallet-test@passsystem-test.iam.gserviceaccount.com',
      private_key: pem,
    })}'`,
    'GOOGLE_WALLET_ISSUER_NAME=PassSystem Test',
    'PUBLIC_SITE_URL=http://127.0.0.1:4173',
    '',
  ].join('\n'),
)
console.log('Wrote supabase/functions/.env (test-only wallet key).')
