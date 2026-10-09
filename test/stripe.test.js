// Stripe webhook: a correctly signed event activates the company; a forged one is refused.
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_PRICE_STARTER = 'price_starter';
process.env.STRIPE_PRICE_PRO = 'price_pro';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_testsecret';
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const Stripe = require('stripe');
const { app } = require('../src/server');
const { migrate } = require('../src/migrate');
const db = require('../src/db');

let server, base, companyId;
before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  companyId = (await db.one("INSERT INTO companies (name, slug, trial_ends_at) VALUES ('Co','co', now() - interval '1 day') RETURNING id")).id;
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.close(); await db.pool.end(); });

const payload = (status) => JSON.stringify({ id: 'evt_1', object: 'event', type: 'customer.subscription.updated',
  data: { object: { id: 'sub_9', object: 'subscription', customer: 'cus_9', status, metadata: { company_id: String(companyId) },
                    items: { data: [{ id: 'si_1', price: { id: 'price_pro' } }] } } } });

test('signed webhook updates the plan', async () => {
  const body = payload('active');
  const sig = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_testsecret' });
  const r = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body });
  assert.strictEqual(r.status, 200);
  const c = await db.one('SELECT plan_status, stripe_subscription_id, plan_tier FROM companies WHERE id=$1', [companyId]);
  assert.deepStrictEqual(c, { plan_status: 'active', stripe_subscription_id: 'sub_9', plan_tier: 'pro' }, 'tier comes from the Stripe price');
});

test('forged webhook is refused', async () => {
  const body = payload('canceled');
  const sig = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_WRONG' });
  const r = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body });
  assert.strictEqual(r.status, 400);
  const c = await db.one('SELECT plan_status FROM companies WHERE id=$1', [companyId]);
  assert.strictEqual(c.plan_status, 'active');
});

test('backup needs the token', async () => {
  assert.strictEqual((await fetch(base + '/api/backup')).status, 401);
});

test('a duplicate subscription ending does not switch off the good one', async () => {
  const body = JSON.stringify({ id: 'evt_2', object: 'event', type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_dup', object: 'subscription', customer: 'cus_9', status: 'canceled', metadata: { company_id: String(companyId) },
                      items: { data: [{ id: 'si_2', price: { id: 'price_starter' } }] } } } });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_testsecret' });
  const r = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body });
  assert.strictEqual(r.status, 200);
  const c = await db.one('SELECT plan_status, stripe_subscription_id FROM companies WHERE id=$1', [companyId]);
  assert.deepStrictEqual(c, { plan_status: 'active', stripe_subscription_id: 'sub_9' });
});
