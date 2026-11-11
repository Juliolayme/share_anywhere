package app.shareanywhere.config

import app.shareanywhere.BuildConfig

/** Build-time feature flags (CLAUDE.md §8b). Each turns on in the milestone that makes it work. */
data class Flags(
    /** Send and Receive flows (milestone 6.2). */
    val sharing: Boolean,
    /** Sign in, account Devices list, history sync (milestone 6.4). */
    val accounts: Boolean,
    /** Clipboard Sync tab (milestone 6.4; needs [accounts]). */
    val clipboard: Boolean
)

/** Values fixed at build time, read once from BuildConfig. */
data class AppConfig(
    val backendUrl: String,
    /** Origin of share links and QR payloads (`SA_PUBLIC_URL`). */
    val publicUrl: String,
    val versionName: String,
    val versionCode: Int,
    val debug: Boolean,
    val flags: Flags
) {
    companion object {
        fun fromBuildConfig() = AppConfig(
            backendUrl = BuildConfig.BACKEND_URL,
            publicUrl = BuildConfig.PUBLIC_URL,
            versionName = BuildConfig.VERSION_NAME,
            versionCode = BuildConfig.VERSION_CODE,
            debug = BuildConfig.DEBUG,
            flags =
            Flags(
                sharing = BuildConfig.FLAG_SHARING,
                accounts = BuildConfig.FLAG_ACCOUNTS,
                clipboard = BuildConfig.FLAG_CLIPBOARD && BuildConfig.FLAG_ACCOUNTS
            )
        )
    }
}
