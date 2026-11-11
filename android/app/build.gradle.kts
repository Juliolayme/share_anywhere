import java.nio.file.Files
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Share Anywhere for Android (docs/phases/PHASE_6_ANDROID.md, docs/ARCHITECTURE.md §2).
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ktlint)
}

// Backend base URL. Debug defaults to the host machine as the emulator sees it; `-Pbackend=` overrides it
// (docs/TESTING_AND_CI.md §2.1). Release builds must name an HTTPS backend with `-PreleaseBackend=`.
val debugBackend: String = (findProperty("backend") as String?) ?: "http://10.0.2.2:8080"
val releaseBackend: String = (findProperty("releaseBackend") as String?) ?: ""
require(releaseBackend.isEmpty() || releaseBackend.startsWith("https://")) {
    "releaseBackend must be an https:// URL (cleartext is allowed only in debug builds)"
}
// Build-time feature flags (CLAUDE.md §8b): each turns on only in the milestone that makes it work.
val flags =
    mapOf(
        // Send and Receive (milestone 6.2).
        "FLAG_SHARING" to false,
        // Sign in, account Devices list, history sync (milestone 6.4).
        "FLAG_ACCOUNTS" to false,
        // Clipboard Sync tab (milestone 6.4).
        "FLAG_CLIPBOARD" to false
    )

android {
    namespace = "app.shareanywhere"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.shareanywhere"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Each instrumentation test starts from a fresh install (docs/TESTING_AND_CI.md §5).
        testInstrumentationRunnerArguments["clearPackageData"] = "true"
        // Tests that need the backend run only when CI passes -Pbackend (android-emulator.yml).
        findProperty("backend")?.let { testInstrumentationRunnerArguments["backend"] = it.toString() }
        flags.forEach { (name, on) -> buildConfigField("boolean", name, on.toString()) }
    }

    buildTypes {
        debug {
            buildConfigField("String", "BACKEND_URL", "\"$debugBackend\"")
        }
        release {
            // No signing config in the repository (CLAUDE.md §3.10): release APKs are signed outside it.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "BACKEND_URL", "\"$releaseBackend\"")
            vcsInfo.include = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // Reproducible APKs: no dependency metadata blob signed with a per-build key.
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }

    // The in-app language switch (Settings › Language) needs every language in the installed APK, so app bundles
    // must not split resources by language.
    bundle {
        language {
            enableSplit = false
        }
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/LICENSE*.md")
    }

    testOptions {
        execution = "ANDROIDX_TEST_ORCHESTRATOR"
        animationsDisabled = true
        unitTests {
            isIncludeAndroidResources = true
            all {
                // Generated-source consistency tests read shared/ (tokens, i18n, openapi) from the repository.
                it.systemProperty("sa.repoRoot", rootProject.projectDir.parentFile.absolutePath)
            }
        }
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = false
        lintConfig = file("lint.xml")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    doFirst {
        check(releaseBackend.isNotEmpty()) { "Release builds need -PreleaseBackend=https://…" }
    }
}

// Robolectric's Android framework jar is resolved by Gradle (cached, locked, proxy-aware) instead of Robolectric's
// own downloader, and tests run with robolectric.offline. The version is the one Robolectric pairs with SDK 35
// (src/test/resources/robolectric.properties).
val robolectricRuntime: Configuration by configurations.creating
val robolectricJars = layout.buildDirectory.dir("robolectric-jars")
val syncRobolectricJars by tasks.registering {
    // Symbolic links into the Gradle cache: the jar is about 200 MB, so it is not copied.
    val jars: FileCollection = robolectricRuntime
    val dir = robolectricJars
    inputs.files(jars)
    outputs.dir(dir)
    doLast {
        val out = dir.get().asFile
        out.deleteRecursively()
        out.mkdirs()
        jars.forEach { Files.createSymbolicLink(out.toPath().resolve(it.name), it.toPath()) }
    }
}
tasks.withType<Test>().configureEach {
    dependsOn(syncRobolectricJars)
    systemProperty("robolectric.offline", "true")
    systemProperty("robolectric.dependency.dir", robolectricJars.get().asFile.absolutePath)
}

// Every resolved configuration is locked; refresh with ./gradlew <tasks> --write-locks.
dependencyLocking {
    lockAllConfigurations()
}

ktlint {
    android.set(true)
    // Generated from shared/ by the root scripts; their format is owned by the generators.
    filter {
        exclude { it.file.path.contains("/generated/") }
        exclude("**/*.gen.kt")
        exclude("**/ui/theme/Tokens.kt")
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.hilt.navigation.compose)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.hilt.android)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    ksp(libs.hilt.compiler)
    ksp(libs.androidx.room.compiler)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)

    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestUtil(libs.androidx.test.orchestrator)
    androidTestUtil(libs.androidx.test.services)

    robolectricRuntime(libs.robolectric.android.all) { isTransitive = false }
}
