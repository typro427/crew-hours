// All settings come from environment variables (set them in Render > Environment).
const env = process.env;

const config = {
  port: Number(env.PORT || 3000),
  // Your public address. On Render, RENDER_EXTERNAL_URL is filled in automatically if APP_URL is left blank.
  appUrl: (env.APP_URL || env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres@localhost:5432/crewhours',
  databaseSsl: env.DATABASE_SSL === 'false' ? false : /render\.com|amazonaws|supabase|neon/.test(env.DATABASE_URL || ''),
  // Long random string. Used to sign PINs and session tokens. Never change it once you have customers.
  secret: env.SESSION_SECRET || 'dev-only-secret-change-me',
  isProd: env.NODE_ENV === 'production',
  trialDays: Number(env.TRIAL_DAYS || 14),
  productName: env.PRODUCT_NAME || 'Crew Hours',
  // Two plans: Starter (up to 20 crew) and Pro (21-50 crew). Price IDs come from Stripe.
  plans: {
    starter: { price: env.PRICE_STARTER || '$14.99', priceId: env.STRIPE_PRICE_STARTER || env.STRIPE_PRICE_ID || '' },
    pro:     { price: env.PRICE_PRO || '$29.99',     priceId: env.STRIPE_PRICE_PRO || '' }
  },
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || ''
  },
  mail: {
    // Any SMTP provider works (Resend, Postmark, SendGrid, Gmail): smtp://user:pass@host:587
    smtpUrl: env.SMTP_URL || '',
    from: env.MAIL_FROM || 'Crew Hours <no-reply@example.com>',
    // In development, emails are written to the console instead of sent.
    logOnly: !env.SMTP_URL
  },
  // Lets your home computer download a nightly backup: GET /api/backup with this as a Bearer token.
  backupToken: env.BACKUP_TOKEN || ''
};

if (config.isProd && config.secret === 'dev-only-secret-change-me') {
  throw new Error('Set SESSION_SECRET before running in production.');
}

module.exports = config;
