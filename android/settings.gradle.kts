// Share Anywhere Android (docs/phases/PHASE_6_ANDROID.md). One application module; protocol models, tokens and
// strings are generated into it from shared/ by the root scripts (pnpm protocol, tokens, i18n).
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal {
            content { includeGroup("org.jlleitschuh.gradle") }
        }
    }
}

rootProject.name = "share-anywhere-android"
include(":app")
