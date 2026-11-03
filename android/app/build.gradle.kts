import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val summonRelease = JsonSlurper().parse(rootProject.file("../release.json")) as Map<*, *>

android {
    namespace = "org.lin0.relay"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.lin0.relay"
        minSdk = 26
        targetSdk = 35
        versionCode = (summonRelease["buildNumber"] as Number).toInt()
        versionName = summonRelease["version"] as String
        buildConfigField("String", "SUMMON_UPDATE_URL", "\"${summonRelease["appUrl"]}/api/releases/android/universal/latest.json\"")
    }

    signingConfigs {
        if (!System.getenv("SUMMON_ANDROID_KEYSTORE").isNullOrBlank()) {
            create("release") {
                storeFile = file(System.getenv("SUMMON_ANDROID_KEYSTORE"))
                storePassword = System.getenv("SUMMON_ANDROID_STORE_PASSWORD")
                keyAlias = System.getenv("SUMMON_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("SUMMON_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.navigation:navigation-compose:2.8.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
