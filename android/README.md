# Bill's Billables (Android)

An Android app with just **Bill's Billables**: address jobs with time in/out, chemical and material costs, and receipt photos. Everything Bill saves goes straight into Crew Hours. It shows up on the dashboard and in the monthly invoices, the same as when he uses the crew app.

## Install it on Bill's phone

1. On the phone, open **https://github.com/typro427/crew-hours/releases/tag/billables-latest** and tap **BillsBillables.apk**.
2. When it finishes downloading, tap it. If Android asks, allow installing apps from the browser (Settings › Apps › Special app access › Install unknown apps › Chrome › Allow).
3. Tap **Install**, then **Open**.
4. Enter the crew link (mycrewhours.com/c/your-company) once, then Bill's PIN.

To update, download and install the new APK the same way. It installs over the old one and keeps his sign-in link.

## How it's built

Each change under `android/` is built on GitHub (Actions › "Bill's Billables APK") and replaces the APK at the link above. To skip typing the crew link, put it in `DEFAULT_LINK` in `MainActivity.java`.

- The app opens the crew app with `?only=jobs`, which hides every tab except Bill's Billables.
- **Camera:** "Add receipts" offers the camera or the gallery. Photos taken are also saved to Pictures › Bill's Billables.
- **No signal:** it works offline and sends jobs when signal comes back, after the first time it opens.
- **Changing company:** on the PIN screen, tap "Different company? Change the crew link".

The signing key (`billables.keystore`) is kept in the repo so every build can update the last one. That's fine for installing the APK directly. For the Google Play Store, Play signs with its own key.
