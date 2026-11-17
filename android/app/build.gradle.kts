plugins {
    id("com.android.application")
}

android {
    namespace = "com.deerfieldmanagement.billables"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.deerfieldmanagement.billables"
        minSdk = 26          // Android 8 and newer
        targetSdk = 35
        // each build on GitHub gets a higher number, so a new APK installs over the old one
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
    }

    signingConfigs {
        // The same key every build, so updates install over the old version. Fine for installing the APK directly;
        // for the Google Play Store, Play signs the app with its own key.
        create("release") {
            storeFile = file("../billables.keystore")
            storePassword = "billables-crewhours"
            keyAlias = "billables"
            keyPassword = "billables-crewhours"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
