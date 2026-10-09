// Stripe: start a subscription (Checkout), manage it (Customer Portal), and listen for changes (webhook).
const express = require('express');
const db = require('../db');
const A = require('../auth');
const config = require('../config');
const P = require('../plans');
const V = require('../validate');

let stripe = null;
const getStripe = () => {
  if (!config.stripe.secretKey) return null;
  // Managed Payments (Stripe handles sales tax) needs API version 2025-03-31.basil or newer.
  if (!stripe) stripe = require('stripe')(config.stripe.secretKey, { apiVersion: process.env.STRIPE_API_VERSION || '2025-03-31.basil' });
  return stripe;
};

const r = require('../router')();

/** Stripe's subscription status -> ours. */
function mapStatus(s) {
  if (s === 'active' || s === 'trialing') return 'active';
  if (s === 'past_due' || s === 'unpaid' || s === 'incomplete') return 'past_due';
  return 'canceled';
}

/** How good a subscription is: 3 = paying and staying, 2 = set to cancel, 1 = payment problem, 0 = ended. */
function rank(sub) {
  const st = mapStatus(sub.status);
  if (st === 'canceled') return 0;
  if (st === 'past_due') return 1;
  return sub.cancel_at_period_end || sub.cancel_at ? 2 : 3;
}
const best = subs => subs.slice().sort((a, b) => rank(b) - rank(a) || b.created - a.created)[0];

const activeCount = async id => (await db.one('SELECT count(*)::int AS n FROM crew WHERE company_id=$1 AND active', [id])).n;

/** Picks the plan from the request and checks the crew fit on it. */
async function chosenPlan(req) {
  const plan = P.PLANS[req.body && req.body.plan];
  if (!plan) V.bad('Pick a plan.');
  if (!plan.priceId) V.bad(`The ${plan.name} plan isn't set up in Stripe yet.`);
  const active = await activeCount(req.company.id);
  if (active > plan.maxCrew) V.bad(`You have ${active} active crew. ${plan.name} covers up to ${plan.maxCrew}. Pick Pro, or turn some crew off first.`);
  return plan;
}

r.post('/checkout', A.requireOwner, async (req, res) => {
  const s = getStripe();
  if (!s) return res.status(503).json({ error: 'Payments are not set up yet.' });
  const plan = await chosenPlan(req);
  const c = req.company;
  if (c.stripe_subscription_id && c.plan_status !== 'canceled') V.bad('You already have a subscription. Use Change plan instead.');
  // Ask Stripe too, in case a webhook was missed: never start a second subscription.
  if (c.stripe_customer_id) {
    const live = (await s.subscriptions.list({ customer: c.stripe_customer_id, status: 'all', limit: 10 })).data.filter(x => rank(x) > 0);
    if (live.length) { await applySubscription(withCompany(best(live), c)); V.bad('You already have a subscription. Refresh this page to see it.'); }
  }
  let customer = c.stripe_customer_id;
  if (!customer) {
    const cu = await s.customers.create({ email: req.owner.email, name: c.name, metadata: { company_id: String(c.id) } });
    customer = cu.id;
    await db.q('UPDATE companies SET stripe_customer_id=$1 WHERE id=$2', [customer, c.id]);
  }
  // Keep whatever is left of the free trial: billing starts when the trial would have ended.
  const trialEnd = c.plan_status === 'trialing' && c.trial_ends_at ? Math.floor(new Date(c.trial_ends_at) / 1000) : null;
  const session = await s.checkout.sessions.create({
    mode: 'subscription', customer,
    line_items: [{ price: plan.priceId, quantity: 1 }],
    subscription_data: { metadata: { company_id: String(c.id), plan: plan.key }, ...(trialEnd && trialEnd > Date.now() / 1000 + 172800 ? { trial_end: trialEnd } : {}) },
    metadata: { company_id: String(c.id) },
    allow_promotion_codes: true,
    success_url: `${config.appUrl}/admin#billing-done`,
    cancel_url: `${config.appUrl}/admin#billing`
  });
  res.json({ url: session.url });
});

/** Switch an existing subscription between Starter and Pro. Stripe pro-rates the difference. */
r.post('/change-plan', A.requireOwner, async (req, res) => {
  const s = getStripe();
  if (!s) return res.status(503).json({ error: 'Payments are not set up yet.' });
  const plan = await chosenPlan(req), c = req.company;
  if (!c.stripe_subscription_id || c.plan_status === 'canceled') V.bad('Subscribe first.');
  if (c.plan_tier === plan.key) return res.json({ ok: true, tier: plan.key });
  const sub = await s.subscriptions.retrieve(c.stripe_subscription_id);
  const updated = await s.subscriptions.update(sub.id, {
    items: [{ id: sub.items.data[0].id, price: plan.priceId }],
    proration_behavior: 'create_prorations',
    metadata: { company_id: String(c.id), plan: plan.key }
  });
  await applySubscription(updated);
  res.json({ ok: true, tier: plan.key });
});

/** Ask Stripe directly for this company's newest subscription (backup for a missed or failed webhook). */
async function syncFromStripe(c) {
  const s = getStripe();
  if (!s || !c.stripe_customer_id) return false;
  const subs = await s.subscriptions.list({ customer: c.stripe_customer_id, status: 'all', limit: 10 });
  const pick = best(subs.data);
  if (!pick) return false;
  await applySubscription(withCompany(pick, c), { force: true });
  return true;
}
const withCompany = (sub, c) => ({ ...sub, metadata: { ...(sub.metadata || {}), company_id: (sub.metadata && sub.metadata.company_id) || String(c.id) } });

r.post('/sync', A.requireOwner, async (req, res) => res.json({ synced: await syncFromStripe(req.company) }));

r.post('/portal', A.requireOwner, async (req, res) => {
  const s = getStripe();
  if (!s || !req.company.stripe_customer_id) return res.status(400).json({ error: 'There is no subscription to manage yet.' });
  const session = await s.billingPortal.sessions.create({ customer: req.company.stripe_customer_id, return_url: `${config.appUrl}/admin#billing` });
  res.json({ url: session.url });
});

async function applySubscription(sub, { force = false } = {}) {
  const companyId = Number(sub.metadata && sub.metadata.company_id) || null;
  // A second (duplicate) subscription ending must not switch off a company whose main one is still good.
  if (!force && rank(sub) < 3) {
    const cur = companyId ? await db.one('SELECT stripe_subscription_id, plan_status FROM companies WHERE id=$1', [companyId])
                          : await db.one('SELECT stripe_subscription_id, plan_status FROM companies WHERE stripe_customer_id=$1', [sub.customer]);
    if (cur && cur.stripe_subscription_id && cur.stripe_subscription_id !== sub.id && cur.plan_status === 'active') return;
  }
  const status = mapStatus(sub.status);
  // Which plan: from the price on the subscription (works even if changed in Stripe), else the metadata.
  const priceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
  const plan = P.planByPriceId(priceId) || P.PLANS[sub.metadata && sub.metadata.plan] || null;
  const tier = plan ? plan.key : null;
  if (companyId) await db.q(`UPDATE companies SET plan_status=$1, stripe_subscription_id=$2, stripe_customer_id=COALESCE(stripe_customer_id,$3),
                             plan_tier=COALESCE($4, plan_tier) WHERE id=$5`, [status, sub.id, sub.customer, tier, companyId]);
  else await db.q('UPDATE companies SET plan_status=$1, stripe_subscription_id=$2, plan_tier=COALESCE($3, plan_tier) WHERE stripe_customer_id=$4', [status, sub.id, tier, sub.customer]);
}

/** Mounted separately with a raw body, because Stripe signs the exact bytes. */
const webhook = express.Router();
webhook.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const s = getStripe();
  if (!s || !config.stripe.webhookSecret) return res.status(503).send('not configured');
  let event;
  try { event = s.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.stripe.webhookSecret); }
  catch (e) { return res.status(400).send('bad signature'); }
  try {
    const o = event.data.object;
    if (event.type === 'checkout.session.completed' && o.subscription) await applySubscription(await s.subscriptions.retrieve(o.subscription));
    if (/^customer\.subscription\.(created|updated|deleted|resumed|paused)$/.test(event.type)) await applySubscription(o);
    res.json({ received: true });
  } catch (e) { console.error('[stripe webhook]', event && event.type, e); res.status(500).send('error: ' + (e && e.message ? e.message : String(e)).slice(0, 500)); }
});

module.exports = { router: r, webhook, mapStatus, applySubscription, syncFromStripe };
