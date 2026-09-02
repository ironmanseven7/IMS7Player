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
        versionCode = 5
        versionName = "1.8.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
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
