# Tapp Android corpus

Three native, SDK-free fixture apps exercise the ADB/UIAutomator driver:

- `demoapp` — onboarding, dashboard, summary, and settings navigation.
- `logindemo` — semantic email/password fields and authenticated content.
- `shopdemo` — browse, product, cart, checkout, and confirmation state.

Build all APKs with JDK 17 and Android SDK 35 (the Gradle wrapper is committed):

```bash
./gradlew :demoapp:assembleDebug :logindemo:assembleDebug :shopdemo:assembleDebug
```

Each module contains committed `.autotap/flows/*.yml` files. Run one with:

```bash
adb install -r demoapp/build/outputs/apk/debug/demoapp-debug.apk
npx -y @aarwitz/tapp flow run demoapp/.autotap/flows/smoke.yml \
  --platform android --app-id io.tapp.corpus.demo \
  --apk demoapp/build/outputs/apk/debug/demoapp-debug.apk
```

Run the complete corpus—build, autonomous QA, deterministic Flows, reports, and gate exits—with:

```bash
../scripts/android-corpus-e2e.sh emulator-5554
```
