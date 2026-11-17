# Crew Hours for iPhone

The crew app (mycrewhours.com/c/your-company) as a real iPhone app, with what the website can't do on a phone:

- **GPS keeps recording with the phone locked** during Start drive (Roads driven). iPhone shows the blue location pill while it records, and it stops when they tap Save track.
- **Apple notifications** for new tasks, urgent leaks and weather reminders, without the "Add to Home Screen" step.
- **Camera and photos** for jobs, leaks and receipts, and **offline mode**: it works with no signal and sends everything when signal comes back.
- **Opens straight to the PIN screen** after the first launch.

The app shows the live crew site, so changes to the crew app go out right away without a new App Store version. You only rebuild when the iPhone side changes.

---

## What you need

- A **Mac with Xcode** (free from the Mac App Store; version 16 or newer).
- An **Apple Developer Program** membership ($99 a year): developer.apple.com/programs. Enroll as your business (Deerfield Management) if the app should show your company's name in the App Store. That needs a D-U-N-S number and can take a few days.

## 1. Open it in Xcode

1. On the Mac: clone the repo (`git clone https://github.com/typro427/crew-hours.git`), or download it from GitHub as a ZIP.
2. Open **`ios/CrewHours.xcodeproj`**.
3. Click **CrewHours** at the top of the left sidebar, then the **CrewHours** target, then **Signing & Capabilities**:
   - **Team:** pick your developer team.
   - **Bundle Identifier:** `com.deerfieldmanagement.crewhours`. Change it if Xcode says it's taken. It must be unique to you.
   - Push Notifications and Background Modes (Location updates, Remote notifications) are already turned on.
4. **Optional:** in `CrewHours/Config.swift`, put your crew link in `defaultCrewLink` (e.g. `"https://mycrewhours.com/c/deerfield-water-system/"`). Then the crew never has to type it. Leave it empty and the app asks for it the first time.
5. Plug in your iPhone, pick it at the top of Xcode, and press **▶ Run**. The first time, approve the developer on the phone: Settings › General › VPN & Device Management.

## 2. Notifications (one time)

1. developer.apple.com › Account › **Certificates, IDs & Profiles › Keys** › **+**. Name it "Crew Hours push", tick **Apple Push Notifications service (APNs)**, then Continue and Register. **Download the .p8 file** (Apple lets you download it only once) and note the **Key ID**.
2. Your **Team ID** is at the top right of developer.apple.com › Account (Membership details).
3. In **Render** › your service › **Environment**, add:
   - `APNS_KEY`: open the .p8 file in TextEdit and paste everything, including the BEGIN and END lines.
   - `APNS_KEY_ID`: the Key ID.
   - `APNS_TEAM_ID`: your Team ID.
   - `APNS_TOPIC`: the Bundle Identifier from step 1 (`com.deerfieldmanagement.crewhours`).
   
   Save, and let Render redeploy. Keep the .p8 file private, the same as a password.

Builds run straight from Xcode use Apple's test notification server; TestFlight and App Store builds use the real one. The app tells Crew Hours which it is, so both work.

## 3. TestFlight for the crew

1. **App Store Connect** (appstoreconnect.apple.com) › **Apps** › **+ New App**: iOS, name "Crew Hours" (or "Crew Hours – Deerfield" if the name is taken), the same Bundle ID, any SKU (e.g. `crewhours1`).
2. In Xcode: set the device at the top to **Any iOS Device (arm64)**, then **Product › Archive**.
3. When the Organizer opens: **Distribute App › App Store Connect › Distribute**. Wait about 10–30 minutes for it to process; you'll get an email.
4. App Store Connect › your app › **TestFlight**:
   - **Internal testing** (instant, up to 100 people): each tester must be added as a user in App Store Connect (Users and Access). Good for you and Scott.
   - **External testing** (the crew, up to 10,000): create a group, add the build, and fill in "What to test". Apple does a short beta review (usually under a day). Then turn on a **Public Link** and text it to the crew.
5. The crew installs **TestFlight** from the App Store, opens your link, and taps Install. TestFlight builds last 90 days.

For each new test version, raise **Build** (General tab: 1 → 2 → 3), then Archive and Distribute again.

## 4. Going live on the App Store

In App Store Connect › your app › the iOS version:
- **Screenshots:** 6.9" iPhone. Take them on a big iPhone, or in the Simulator with ⌘S.
- **Description, keywords, support URL** (`https://mycrewhours.com`), **privacy policy URL** (`https://mycrewhours.com/privacy`).
- **App Privacy:** Location (precise; app functionality; linked to the user; not tracking), Name, Photos, Other user content and Device ID (for notifications), all for app functionality.
- **App Review information: a sign-in Apple can use.** Make a demo crew member (say PIN 1234) in a test company, put its crew link in the notes, and explain that Start drive uses location to tick roads as you drive.
- **Background location:** in the notes, say location is used only while a crew member records a drive, which they start and stop themselves, and that it keeps recording when the phone locks so the whole route is saved.

Then **Add for Review**, then **Submit**. Reviews usually take 1–2 days.

## When something goes wrong

- **Build error:** copy the red error from Xcode's Issue navigator and send it to Claude.
- **"No connection" on first open:** the phone needs signal the first time. After that the crew app works offline.
- **Notifications don't arrive:** check the four `APNS_` settings in Render, and that the phone allowed notifications (Settings › Notifications › Crew Hours). Then tap the 🔕 bell in the app once.
- **GPS doesn't record with the phone locked:** check Settings › Crew Hours › Location is set to **While Using the App** (not Never).
- **Changing company:** on the PIN screen, tap **Different company? Change the crew link**.

## What's in here

| File | What it does |
|---|---|
| `CrewHours/CrewHoursApp.swift` | Starts the app; shows the crew link screen or the crew app |
| `CrewHours/SetupView.swift` | First launch: enter the crew link |
| `CrewHours/CrewWebScreen.swift` | The crew app in a web view: links, downloads, camera, pull to refresh, offline screen |
| `CrewHours/Bridge.swift` | Tells the crew site it's inside the app, and gives it the phone's GPS |
| `CrewHours/LocationBridge.swift` | GPS, including with the phone locked during a drive |
| `CrewHours/AppDelegate.swift` | Apple notifications: permission, the phone's push token, opening the right tab |
| `CrewHours/Config.swift` | The site address and your crew link |
| `Config/Info.plist` | Permission messages, background modes, the site for offline mode |
| `Config/CrewHours.entitlements` | Push notifications |
| `CrewHours/PrivacyInfo.xcprivacy` | Apple's privacy manifest |
