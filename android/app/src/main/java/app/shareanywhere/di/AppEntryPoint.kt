package app.shareanywhere.di

import app.shareanywhere.history.HistoryRepository
import app.shareanywhere.settings.SettingsRepository
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/**
 * Access to singletons from code Hilt does not construct: instrumentation tests that drive the real app
 * (src/androidTest) use it to seed and read local History.
 */
@EntryPoint
@InstallIn(SingletonComponent::class)
interface AppEntryPoint {
    fun historyRepository(): HistoryRepository

    fun settingsRepository(): SettingsRepository
}
