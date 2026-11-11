package app.shareanywhere.di

import app.shareanywhere.config.AppConfig
import app.shareanywhere.data.api.SessionsApi
import app.shareanywhere.history.HistoryRepository
import app.shareanywhere.settings.SettingsRepository
import app.shareanywhere.ui.keepawake.KeepAwakeController
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/**
 * Access to singletons from code Hilt does not construct: instrumentation tests that drive the real app
 * (src/androidTest) use it to seed and read local History, call the API as this device, and read the keep-awake state.
 */
@EntryPoint
@InstallIn(SingletonComponent::class)
interface AppEntryPoint {
    fun historyRepository(): HistoryRepository

    fun settingsRepository(): SettingsRepository

    fun sessionsApi(): SessionsApi

    fun keepAwake(): KeepAwakeController

    fun config(): AppConfig

    fun outgoingFiles(): app.shareanywhere.transfer.OutgoingFileDao

    fun transferRuntime(): app.shareanywhere.transfer.runtime.TransferRuntime

    fun identity(): app.shareanywhere.identity.IdentityManager

    fun accountManager(): app.shareanywhere.account.AccountManager

    fun clipboardRuntime(): app.shareanywhere.clipboard.ClipboardRuntime
}
