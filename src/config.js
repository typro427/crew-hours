// All settings come from environment variables (set them in Render > Environment).
const env = process.env;

const clean = v => String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();

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
    logOnly: !env.SMTP_URL,
    // Optional second mailbox for address-job invoices (e.g. Bill's own Gmail), so they come from his address:
    // smtps://newtenn310%40gmail.com:APP_PASSWORD@smtp.gmail.com:465
    invoiceSmtpUrl: env.INVOICE_SMTP_URL || ''
  },
  // Lets your home computer download a nightly backup: GET /api/backup with this as a Bearer token.
  backupToken: env.BACKUP_TOKEN || '',
  google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '' },
  // Weather reminders: National Weather Service forecast (free, US) and the US Census address lookup.
  weather: { api: env.WEATHER_API || 'https://api.weather.gov', geocoder: env.GEOCODER_URL || 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress',
    cacheMs: env.WEATHER_CACHE_MS != null ? Number(env.WEATHER_CACHE_MS) : 30 * 60e3 },   // the Weather Service updates about hourly
  // Road shapes for the roads driven checklist (OpenStreetMap), and how far around the company to look.
  geo: { overpass: env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter', radius: Number(env.ROAD_SEARCH_METERS) || 6000 },
  // QuickBooks Online (owners see their balance and invoices in the owner portal). Keys from developer.intuit.com.
  // QBO_SANDBOX=1 uses Intuit's test companies.
  qbo: {
    // trimmed, and quotes removed: a pasted key with a space or quotes around it would otherwise not work
    clientId: clean(env.QBO_CLIENT_ID), clientSecret: clean(env.QBO_CLIENT_SECRET),
    authUrl: env.QBO_AUTH_URL || 'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl: env.QBO_TOKEN_URL || 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    revokeUrl: env.QBO_REVOKE_URL || 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
    apiBase: env.QBO_API_BASE || (env.QBO_SANDBOX === '1' ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com')
  }
};

if (config.isProd && config.secret === 'dev-only-secret-change-me') {
  throw new Error('Set SESSION_SECRET before running in production.');
}

module.exports = config;
