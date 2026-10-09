// The two plans. A company's plan sets how many crew can be active (able to log in) at once.
const config = require('./config');

const PLANS = {
  starter: { key: 'starter', name: 'Starter', maxCrew: 20, price: config.plans.starter.price, priceId: config.plans.starter.priceId },
  pro:     { key: 'pro',     name: 'Pro',     maxCrew: 50, price: config.plans.pro.price,     priceId: config.plans.pro.priceId }
};
const TRIAL_MAX = 50;          // during the free trial everything is open, up to Pro's limit

/** How many active crew this company may have right now. */
function crewLimit(company) {
  if (company.plan_status === 'trialing') return TRIAL_MAX;
  return (PLANS[company.plan_tier] || PLANS.starter).maxCrew;
}

/** The smallest plan that fits this many active crew (null = more than any plan allows). */
function planFor(activeCount) {
  if (activeCount <= PLANS.starter.maxCrew) return PLANS.starter;
  if (activeCount <= PLANS.pro.maxCrew) return PLANS.pro;
  return null;
}

/** Which plan a Stripe price belongs to. */
function planByPriceId(priceId) {
  return Object.values(PLANS).find(p => p.priceId && p.priceId === priceId) || null;
}

function publicPlans() {
  return Object.values(PLANS).map(p => ({ key: p.key, name: p.name, maxCrew: p.maxCrew, price: p.price, ready: !!p.priceId }));
}

module.exports = { PLANS, TRIAL_MAX, crewLimit, planFor, planByPriceId, publicPlans };
