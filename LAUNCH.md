# Launching Crew Hours

This gets Crew Hours live as a paid product: a website where companies sign up, pay monthly, and get their own private crew app. Plan on an afternoon. Do it in this order, and use Stripe **test mode** until the very end.

You'll create 4 accounts: **GitHub** (stores the code), **Render** (runs the app and the database), **Resend** (sends the emails) and **Stripe** (takes payments). All of them are free to start.

---

## 1. Put the code on GitHub (10 min)
1. Go to github.com and sign up, or log in.
2. Click **+ → New repository**. Name it `crew-hours`, choose **Private**, and click **Create repository**.
3. On the empty repo page, click **uploading an existing file**.
4. Unzip `crew-hours.zip` on your computer. Drag **everything inside the folder** (`src`, `public`, `test`, `tools`, `package.json`, `package-lock.json`, `render.yaml`, `LAUNCH.md` and the rest) onto the page, then click **Commit changes**.

## 2. Start it on Render (15 min)
1. In Render, click **New → Blueprint**, connect your GitHub account, and pick the `crew-hours` repo.
2. Render reads `render.yaml` and offers to create **crew-hours** (the app) and **crew-hours-db** (the database). Click **Apply**.
   - Pick the cheapest paid plan for both. The free database plan expires, so don't keep real customers on it.
   - If the Blueprint gives an error, create them by hand instead: **New → PostgreSQL** (name it `crew-hours-db`), then **New → Web Service** from the repo with build command `npm ci --omit=dev`, start command `npm start` and health check path `/healthz`. Then add the variables from `render.yaml` under **Environment**, and set `DATABASE_URL` to the database's **Internal Database URL**.
3. When it finishes, Render shows your address, like `https://crew-hours.onrender.com`. Go to the app's **Environment** tab, set **APP_URL** to that address, and save. Render redeploys automatically.
4. Open the address. You should see the home page. Click **Start free trial** and make a test account.

`SESSION_SECRET` and `BACKUP_TOKEN` are filled in automatically. **Never change SESSION_SECRET after you have customers:** every crew PIN would stop working.

## 3. Turn on email (15 min)
Without this, the weekly summary, missing-hours and password-reset emails don't send.
1. Sign up at resend.com and add your domain under **Domains**. Follow its DNS steps (it walks you through them).
   - No domain yet? Buy one first (step 5), or use Resend's test sender while you try things out.
2. Create an **API key**.
3. In Render → **Environment**, set:
   - `SMTP_URL` = `smtp://resend:YOUR_API_KEY@smtp.resend.com:587`
   - `MAIL_FROM` = `Crew Hours <hours@yourdomain.com>`
4. Test it: in your dashboard, click **Email me this week**.

Any email service with SMTP works (Postmark, SendGrid, Mailgun). Only the `SMTP_URL` changes.

## 4. Turn on payments (20 min, test mode first)
1. Sign up at stripe.com and stay in **Test mode** (the toggle at top right).
2. **Product catalog → Add product**: name it "Crew Hours", **Recurring**, **Monthly**, at your price (e.g. $29). Save, then copy the **Price ID** (starts with `price_`).
3. **Developers → API keys**: copy the **Secret key** (starts with `sk_test_`).
4. **Developers → Webhooks → Add endpoint**:
   - URL: `https://YOUR-APP-ADDRESS/api/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Save, then copy the **Signing secret** (starts with `whsec_`).
5. **Settings → Billing → Customer portal**: turn it on, and allow cancelling and updating the card.
6. In Render → **Environment**, set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET`. If you changed the price, set `PRICE_AMOUNT` (e.g. `$29`) so the home page matches.
7. Test it: in your dashboard, go to **Billing → Subscribe** and pay with card **4242 4242 4242 4242** (any future date, any CVC). The status should change to **Active** within a minute.
8. **Going live:** switch Stripe out of test mode, repeat steps 2–4 with live values, and update the three Render variables.

## 5. Your own web address (optional, 15 min)
1. Buy a domain (Namecheap, Cloudflare, Google Domains).
2. Render → your app → **Settings → Custom Domains**: add it and follow the DNS steps.
3. Change `APP_URL` to `https://yourdomain.com`, and update the Stripe webhook URL to match.

## 6. Before your first paying customer
- **Terms and privacy:** `public/terms.html` and `public/privacy.html` are outlines with [BRACKETS] to fill in. Have a lawyer review them.
- **Business:** set up an LLC (or similar) and a business bank account, and complete your Stripe business profile.
- **Backups:** Render's paid database plans keep automatic backups. For a second copy on your home storage, use `tools/backup.ps1` (Windows Task Scheduler) or `tools/backup.sh` (Mac, Linux or NAS cron). Get the token from Render → Environment → `BACKUP_TOKEN`.

## 7. Move Deerfield onto it
1. Sign up on your new site with your company.
2. In **Settings**: set the week to start on **Thursday**, the main tab to **Deerfield Time**, and the second tab's choices to Water System, McCloud Venue and MtCloud Maintenance.
3. In **Crew & PINs**: add Jake, JT, Matthew and Alan with the same PINs, and tick **Manager** on yourself.
4. Text the crew the new link, and keep the old Google version running until everyone has switched.

---

## Running costs (check current prices; they change)
- Render: the app plus the database on starter plans is roughly $14–20/month.
- Resend: free for low volume.
- Stripe: a percentage plus a small fee on each payment, and nothing when no payments come in.

## What it does today
- Sign up with a 14-day trial (no card), log in, reset your password by email.
- A crew app per company at `/c/your-company`: PIN pad, save as you go, two time tabs, clocked out / back in, a job dropdown, and installs to the home screen.
- Each crew member sees only their own hours. Companies are fully separated, and the tests check this.
- Dashboard: the crew week with approve/lock, crew and PINs (add, edit, turn off), settings, CSV export, and billing.
- Emails at each company's local time: the weekly summary on the first day of the week, and missing hours the evening before the week ends.
- When a trial ends or a subscription lapses, the crew app pauses. Data is kept and the owner can still log in.

## Good next additions
- More than one boss login per company.
- A "delete my account" button (for now, handle deletions by email).
- App Store / Google Play versions.
- Exports to payroll software (QuickBooks, Gusto).

## For a developer
`npm install`, then set the variables from `.env.example` in your shell, then `npm start`. Run the tests with `DATABASE_URL=... npm test`. They need an empty Postgres database and wipe it.
