/**
 * Definition-of-done workflow, end to end in real browsers against the local
 * Supabase stack:
 *   organizer creates + publishes Event A -> attendee registers on a phone ->
 *   operator on another phone scans the QR with the camera (green) -> scanning
 *   again is rejected (red) -> Event B is separate and rejects Event A's pass ->
 *   organizer inspects registrations/attendance and exports CSV.
 */
import { test, expect, chromium, devices, type Browser, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stackEnv } from '../integration/env'
import { writeQrVideo } from './fakeCamera'

const stack = stackEnv()
const service = createClient(stack.apiUrl, stack.serviceKey, { auth: { persistSession: false } })
const ART = join(process.cwd(), 'tests/e2e/.artifacts')
const baseURL = 'http://127.0.0.1:4173'

async function createUser(label: string, admin = false) {
  const email = `${label}-${randomUUID().slice(0, 8)}@passsystem.test`
  const password = `E2e-${randomUUID()}9`
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  if (admin) await service.from('profiles').update({ is_admin: true }).eq('id', data.user.id)
  return { email, password, id: data.user.id }
}

const cspViolations: string[] = []
function watchCsp(page: Page) {
  page.on(
    'console',
    (m) => /Content Security Policy|Refused to/i.test(m.text()) && cspViolations.push(m.text()),
  )
  return page
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/admin$/)
}

async function createEventViaUi(page: Page, name: string) {
  await page.getByRole('link', { name: 'Create event' }).first().click()
  await page.getByLabel('Event name').fill(name)
  await page.getByLabel('Location').fill('Town Hall')
  await page.getByLabel('Time zone').fill('Europe/Belgrade')
  await page.getByLabel('Starts').fill('2026-12-01T19:00')
  await page.getByRole('button', { name: 'Create event' }).click()
  await expect(page).toHaveURL(/\/admin\/events\/[0-9a-f-]{36}$/)
  // Created as draft: publish from the event page.
  await page.getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByText('Published', { exact: true })).toBeVisible()
  const url = (await page.getByTestId('registration-url').innerText()).trim()
  const id = page.url().split('/').pop()!
  return { url, id }
}

let organizer: { email: string; password: string; id: string }
let operator: { email: string; password: string; id: string }

test.beforeAll(async () => {
  organizer = await createUser('e2e-organizer', true)
  operator = await createUser('e2e-operator')
})

test('organizer → attendee → operator camera scan → event isolation → reporting', async ({ browser }) => {
  // ---------------------------------------------------------------- organizer
  const orgCtx = await browser.newContext({ baseURL })
  const org = watchCsp(await orgCtx.newPage())
  await signIn(org, organizer.email, organizer.password)
  const suffix = randomUUID().slice(0, 6)
  const eventA = await createEventViaUi(org, `Event A ${suffix}`)
  expect(eventA.url).toMatch(new RegExp(`/e/event-a-${suffix}$`))

  // Assign the operator to Event A through the Staff tab.
  await org.getByRole('tab', { name: 'Staff' }).click()
  await org.getByLabel('Staff email').fill(operator.email)
  await org.getByRole('button', { name: 'Assign' }).click()
  await expect(org.getByText(operator.email)).toBeVisible()

  // ---------------------------------------------------------------- attendee
  const phone = await browser.newContext({ ...devices['iPhone 13'], baseURL })
  const att = watchCsp(await phone.newPage())
  await att.goto(eventA.url)
  await expect(att.getByRole('heading', { name: `Event A ${suffix}` })).toBeVisible()
  await att.getByLabel('First name').fill('Ana')
  await att.getByLabel('Last name').fill('Petrović')
  await att.getByLabel(/Phone/).fill('+971 50 123 4567')
  await expect(att.getByTestId('terms')).toContainText('not political')
  await att.getByLabel('I have read and accept the attendance terms.').check()
  await att.getByRole('button', { name: 'Get my pass' }).click()
  await expect(att).toHaveURL(/\/pass#[0-9A-Z]{24}$/)
  await expect(att.getByText("You're registered")).toBeVisible()
  await expect(att.getByTestId('pass-name')).toHaveText('Ana Petrović')
  await expect(att.getByRole('img', { name: /Entry QR code/ })).toBeVisible()
  const passUrl = att.url()
  const code = (await att.getByTestId('pass-code').innerText()).trim()

  // Saved pass link reopens on another device.
  const other = await (await browser.newContext({ baseURL })).newPage()
  await other.goto(passUrl)
  await expect(other.getByTestId('pass-name')).toHaveText('Ana Petrović')
  await expect(other.getByText('Valid', { exact: true })).toBeVisible()

  // ------------------------------------------- operator, second phone, camera
  const video = writeQrVideo(passUrl, join(ART, `pass-${suffix}.y4m`))
  const camBrowser: Browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${video}`,
    ],
  })
  try {
    const opCtx = await camBrowser.newContext({ ...devices['Pixel 7'], baseURL, permissions: ['camera'] })
    const op = watchCsp(await opCtx.newPage())
    await signIn(op, operator.email, operator.password)
    await op.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Scan' }).click()
    await expect(op.getByTestId('scan-event-option')).toHaveCount(1) // only assigned event
    await op.getByTestId('scan-event-option').click()
    await expect(op.getByTestId('scan-event')).toContainText(`Event A ${suffix}`)

    let admitCalls = 0
    op.on('request', (r) => r.url().includes('/rpc/admit_pass') && admitCalls++)
    await op.getByRole('button', { name: 'Start camera' }).click()

    const ok = op.getByTestId('scan-result-ok')
    await expect(ok).toBeVisible({ timeout: 20_000 })
    await expect(ok).toContainText('ADMITTED')
    await expect(op.getByTestId('scan-result-name')).toHaveText('Ana Petrović')

    // The QR stays in front of the camera: no repeated backend requests.
    await op.waitForTimeout(5000)
    expect(admitCalls).toBe(1)

    // Present the same pass again after it left the camera: rejected.
    await op.getByRole('button', { name: 'Stop camera' }).click()
    await op.waitForTimeout(3500)
    await op.getByRole('button', { name: 'Start camera' }).click()
    const bad = op.getByTestId('scan-result-bad')
    await expect(bad).toBeVisible({ timeout: 20_000 })
    await expect(bad).toContainText('ALREADY USED')
    await expect(bad).toContainText('Ana Petrović')
    expect(admitCalls).toBe(2)

    // Operator cannot administer the event.
    await op.goto(`/admin/events/${eventA.id}`)
    await expect(op.getByText('Operator access')).toBeVisible()
    await expect(op.getByRole('tab', { name: 'Attendees' })).toHaveCount(0)
    await opCtx.close()
  } finally {
    await camBrowser.close()
  }

  // Attendee's pass page now shows it was used.
  await att.reload()
  await expect(att.getByText(/This pass was used for entry/)).toBeVisible()

  // ---------------------------------------------------------- Event B isolation
  await org.goto('/admin')
  const eventB = await createEventViaUi(org, `Event B ${suffix}`)
  await att.goto(eventB.url)
  // Arabic: right-to-left, and nothing pushes the page sideways (an off-screen element once did).
  await att.getByTestId('lang-switch').click()
  await expect(att.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect(att.getByLabel('الاسم الأول')).toBeVisible()
  expect(await att.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await att.getByTestId('lang-switch').click()
  await att.getByLabel('First name').fill('Marko')
  await att.getByLabel('Last name').fill('Marković')
  await att.getByLabel('Email').fill('marko@example.org')
  await att.getByLabel('I have read and accept the attendance terms.').check()
  await att.getByRole('button', { name: 'Get my pass' }).click()
  await expect(att.getByTestId('pass-name')).toHaveText('Marko Marković')
  const codeB = (await att.getByTestId('pass-code').innerText()).trim()

  // Event A's pass cannot admit to Event B (manual entry fallback).
  await org.goto(`/scan/${eventB.id}`)
  await org.getByLabel('Pass code').fill(code)
  await org.getByRole('button', { name: 'Check' }).click()
  await expect(org.getByTestId('scan-result-bad')).toContainText('WRONG EVENT')
  // Event B's own pass is admitted.
  await org.getByLabel('Pass code').fill(codeB)
  await org.getByRole('button', { name: 'Check' }).click()
  await expect(org.getByTestId('scan-result-ok')).toContainText('Marko Marković')

  // ----------------------------------------------------------------- reporting
  await org.goto(`/admin/events/${eventA.id}?tab=attendees`)
  await expect(org.getByTestId('attendee-row')).toHaveCount(1)
  await expect(org.getByTestId('attendee-row')).toContainText('Ana Petrović')
  await expect(org.getByTestId('attendee-row')).toContainText('Checked in')
  const [download] = await Promise.all([
    org.waitForEvent('download'),
    org.getByRole('button', { name: 'Export CSV' }).click(),
  ])
  const csv = readFileSync(await download.path(), 'utf8')
  expect(csv).toContain('Ana,Petrović')
  expect(csv).toContain('+971501234567')
  expect(csv).toContain('checked_in')
  expect(csv).not.toContain('Marko')

  await org.goto(`/admin/events/${eventB.id}?tab=attendees`)
  await expect(org.getByTestId('attendee-row')).toHaveCount(1)
  await expect(org.getByTestId('attendee-row')).toContainText('Marko Marković')
  await expect(org.getByTestId('attendee-row')).toContainText('marko@example.org')

  await org.goto(`/admin/events/${eventA.id}`)
  const stats = org.getByTestId('stats')
  // Header counts: label, then value.
  await expect(stats).toContainText('Checked in1')
  await expect(stats).toContainText('Still to come0')
  await expect(stats).toContainText('Registered1')

  await org.goto(`/admin/events/${eventA.id}?tab=activity`)
  await expect(org.getByText('Admitted', { exact: true })).toBeVisible()
  await expect(org.getByText('Already used', { exact: true })).toBeVisible()

  expect(cspViolations).toEqual([])
})

test('unauthenticated users are sent to sign-in for staff pages', async ({ page }) => {
  for (const path of ['/admin', '/scan', '/admin/users', `/admin/events/${randomUUID()}`]) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/login\?next=/)
  }
})

test('scanner shows amber "not verified" when the server cannot be reached', async ({ page }) => {
  await signIn(page, organizer.email, organizer.password)
  const { data: ev } = await service
    .from('events')
    .insert({
      name: 'Offline test',
      slug: `offline-${randomUUID().slice(0, 6)}`,
      starts_at: new Date(Date.now() + 864e5).toISOString(),
      status: 'published',
      created_by: organizer.id,
    })
    .select('id')
    .single()
  await service.from('event_staff').upsert({ event_id: ev!.id, user_id: organizer.id, role: 'organizer' })
  await page.goto(`/scan/${ev!.id}`)
  await page.route('**/rest/v1/rpc/admit_pass', (route) => route.abort('internetdisconnected'))
  await page.getByLabel('Pass code').fill('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01')
  await page.getByRole('button', { name: 'Check' }).click()
  const warn = page.getByTestId('scan-result-warn')
  await expect(warn).toContainText('NOT VERIFIED')
  await expect(warn).toContainText('Do not admit')
  await expect(page.getByTestId('scan-result-ok')).toHaveCount(0)
  // Retry once the network is back gives a definitive (here: invalid) answer.
  await page.unroute('**/rest/v1/rpc/admit_pass')
  await warn.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByTestId('scan-result-bad')).toContainText('INVALID PASS')
})

test('scanner explains a denied camera permission and keeps manual entry', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL, permissions: [] })
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
  })
  await signIn(page, organizer.email, organizer.password)
  await page.goto('/scan')
  const first = page.getByTestId('scan-event-option').first()
  await first.click()
  await page.getByRole('button', { name: 'Start camera' }).click()
  await expect(page.getByText(/Camera permission was denied/)).toBeVisible()
  await expect(page.getByLabel('Pass code')).toBeVisible()
  await ctx.close()
})

test('invited staff member sets a password from the invite link and can sign in', async ({ browser }) => {
  const email = `e2e-invitee-${randomUUID().slice(0, 8)}@passsystem.test`
  const { data, error } = await service.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo: `${baseURL}/` },
  })
  expect(error).toBeNull()
  const ctx = await browser.newContext({ baseURL })
  const page = await ctx.newPage()
  await page.goto(data.properties!.action_link)
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible()
  const password = `Invited-${randomUUID().slice(0, 8)}1`
  await page.getByLabel('New password', { exact: true }).fill(password)
  await page.getByLabel('Confirm new password').fill(password)
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByText(/not assigned to any events/)).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await signIn(page, email, password)
  await ctx.close()
})

test('administrator invites staff from the Staff page; invitee sets a password from the email', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ baseURL })
  const page = await ctx.newPage()
  await signIn(page, organizer.email, organizer.password)
  await page.goto('/admin/users')
  const email = `e2e-invited-${randomUUID().slice(0, 8)}@passsystem.test`
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Send invite' }).click()
  await expect(page.getByText(`Invite sent to ${email}`)).toBeVisible()
  await expect(page.getByText(email, { exact: true })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: email })).toContainText('Invite pending')

  // Read the real invite email from the local test mailbox (Mailpit).
  const mailpit = 'http://127.0.0.1:54324'
  let link: string | undefined
  for (let i = 0; i < 30 && !link; i++) {
    const search = await (
      await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
    ).json()
    const id = search.messages?.[0]?.ID
    if (id) {
      const msg = await (await fetch(`${mailpit}/api/v1/message/${id}`)).json()
      link = /href="([^"]+)"/.exec(msg.HTML ?? '')?.[1]?.replace(/&amp;/g, '&')
    }
    if (!link) await page.waitForTimeout(500)
  }
  expect(link, 'invite email with a link').toBeTruthy()

  const invitee = await (await browser.newContext({ baseURL })).newPage()
  await invitee.goto(link!)
  await expect(invitee).toHaveURL(/\/account$/)
  const password = `Invited-${randomUUID().slice(0, 8)}1`
  await invitee.getByLabel('New password', { exact: true }).fill(password)
  await invitee.getByLabel('Confirm new password').fill(password)
  await invitee.getByRole('button', { name: 'Save password' }).click()
  await expect(invitee).toHaveURL(/\/admin$/)
  await expect(invitee.getByText(/not assigned to any events/)).toBeVisible()

  // The administrator removes the account again from the Staff page.
  await page.reload()
  const row = page.getByRole('listitem').filter({ hasText: email })
  page.once('dialog', (d) => d.accept())
  await row.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByText(`${email} was removed.`)).toBeVisible()
  await expect(page.getByText(email, { exact: true })).toHaveCount(0)
  // A browser that is still signed in keeps its access token until it expires, but sees nothing.
  await invitee.reload()
  await expect(invitee.getByText(/not assigned to any events/)).toBeVisible()
  await ctx.close()
})

test('administrator creates an invite link; the invitee accepts it without any email', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ baseURL })
  const page = await ctx.newPage()
  await signIn(page, organizer.email, organizer.password)
  await page.goto('/admin/users')
  const email = `e2e-link-${randomUUID().slice(0, 8)}@passsystem.test`
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Create invite link' }).click()
  await expect(page.getByTestId('invite-link')).toBeVisible()
  const link = await page.getByLabel(`Invite link for ${email}`).inputValue()
  expect(link).toMatch(/\/invite#token=/)
  await expect(page.getByRole('listitem').filter({ hasText: email })).toContainText('Invite pending')

  const invitee = await (await browser.newContext({ baseURL })).newPage()
  await invitee.goto(link)
  await expect(invitee.getByRole('heading', { name: 'You’re invited to PassSystem' })).toBeVisible()
  await invitee.getByRole('button', { name: 'Accept invite' }).click()
  await expect(invitee).toHaveURL(/\/account$/)
  await expect(invitee.getByRole('heading', { name: 'Choose your password' })).toBeVisible()
  const password = `Linked-${randomUUID().slice(0, 8)}1`
  await invitee.getByLabel('New password', { exact: true }).fill(password)
  await invitee.getByLabel('Confirm new password').fill(password)
  await invitee.getByRole('button', { name: 'Save password' }).click()
  await expect(invitee).toHaveURL(/\/admin$/)

  // The same link cannot be used twice.
  const again = await (await browser.newContext({ baseURL })).newPage()
  await again.goto(link)
  await again.getByRole('button', { name: 'Accept invite' }).click()
  await expect(again.getByText(/expired or was already used/)).toBeVisible()
  await ctx.close()
})

test('Staff page deployment check detects a forgeable cf-connecting-ip header (local stack)', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ baseURL })
  const page = await ctx.newPage()
  await signIn(page, organizer.email, organizer.password)
  await page.goto('/admin/users')
  await expect(page.getByTestId('ip-check')).toContainText('x-real-ip')
  await page.getByRole('button', { name: 'Test header spoofing' }).click()
  // Locally nothing replaces the header, so the check must flag it.
  await expect(page.getByTestId('spoof-result')).toContainText('FORGEABLE')
  await ctx.close()
})

test('Add to Google Wallet: Android gets a signed save link; iPhone does not see the button', async ({
  browser,
}) => {
  const { data: ev } = await service
    .from('events')
    .insert({
      name: 'Wallet E2E',
      slug: `wallet-${randomUUID().slice(0, 6)}`,
      starts_at: new Date(Date.now() + 864e5).toISOString(),
      status: 'published',
      created_by: organizer.id,
    })
    .select('slug')
    .single()
  const anon = createClient(stack.apiUrl, stack.anonKey, { auth: { persistSession: false } })
  const { data: pub } = await anon.rpc('get_public_event', { p_slug: ev!.slug })
  const { data: reg } = await anon.rpc('register_for_event', {
    p_slug: ev!.slug,
    p_first_name: 'Wanda',
    p_last_name: 'Wallet',
    p_accept_terms: true,
    p_terms_version: pub.event.terms_version,
  })
  const passPath = `/pass#${reg.token}`

  const android = await (await browser.newContext({ ...devices['Pixel 7'], baseURL })).newPage()
  let saveUrl = ''
  await android.route('https://pay.google.com/**', (route) => {
    saveUrl = route.request().url()
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Google Wallet</p>' })
  })
  await android.goto(passPath)
  await android.getByTestId('google-wallet').click()
  await android.waitForURL(/^https:\/\/pay\.google\.com\//)
  expect(saveUrl).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\/[\w-]+\.[\w-]+\.[\w-]+$/)
  const claims = JSON.parse(
    Buffer.from(saveUrl.split('/').pop()!.split('.')[1]!, 'base64url').toString('utf8'),
  )
  expect(claims.payload.eventTicketObjects[0].ticketHolderName).toBe('Wanda Wallet')

  const iphone = await (await browser.newContext({ ...devices['iPhone 13'], baseURL })).newPage()
  await iphone.goto(passPath)
  await expect(iphone.getByTestId('pass-name')).toHaveText('Wanda Wallet')
  await expect(iphone.getByTestId('google-wallet')).toHaveCount(0)
})
