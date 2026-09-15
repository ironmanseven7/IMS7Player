plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.picksmith.xtream"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.picksmith.xtream"
        // 26 keeps adaptive launcher icons simple and covers Android 8+ phones
        // and every current Android TV box.
        minSdk = 26
        targetSdk = 34
        versionCode = 13
        versionName = "1.11.0"
    }

    // The permanent key, handed to CI builds from repository secrets. Android
    // installs an update only over an app signed with the same key, and the SDK's
    // own debug key is generated afresh on every CI machine - so without this,
    // every build was a different app as far as updating is concerned.
    val ims7Keystore = System.getenv("IMS7_KEYSTORE")
    signingConfigs {
        if (ims7Keystore != null) {
            create("ims7") {
                storeFile = file(ims7Keystore)
                storePassword = System.getenv("IMS7_KEYSTORE_PASSWORD")
                keyAlias = "ims7"
                keyPassword = System.getenv("IMS7_KEYSTORE_PASSWORD")
                storeType = "pkcs12"
            }
        }
    }

    buildTypes {
        getByName("debug") {
            if (ims7Keystore != null) signingConfig = signingConfigs.getByName("ims7")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (ims7Keystore != null) "ims7" else "debug")
        }
    }

    // WebUpdates and UpdateBridge compare against versionName / versionCode.
    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // FileProvider, to hand a downloaded update to the system installer.
    implementation("androidx.core:core:1.13.1")
}

/**
 * public/ is the single source of truth for the UI - the desktop server and the
 * APK serve the identical files. Copy it into assets at build time rather than
 * keeping a second copy in the repo.
 */
val copyWebApp by tasks.registering(Copy::class) {
    from(rootProject.file("../public"))
    into(layout.projectDirectory.dir("src/main/assets/www"))
}
tasks.named("preBuild") { dependsOn(copyWebApp) }
