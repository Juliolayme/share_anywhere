package app.shareanywhere.settings

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import app.shareanywhere.history.Retention
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SettingsRepositoryTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun defaultsAreGuestFirstAndKeepScreenOn() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val repo = SettingsRepository(PreferenceDataStoreFactory.create(scope = scope) { tmp.newFile("a.preferences_pb") })
        val s = repo.settings.first()
        assertFalse(s.welcomed)
        assertTrue(s.keepScreenOn)
        assertEquals(ThemeMode.SYSTEM, s.theme)
        assertEquals(AppLanguage.SYSTEM, s.language)
        assertEquals(Retention.DAYS_30, s.retention)
        scope.cancel()
    }

    @Test
    fun choicesPersistAcrossInstances() = runBlocking {
        val file = tmp.root.resolve("b.preferences_pb")
        val first = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        SettingsRepository(PreferenceDataStoreFactory.create(scope = first) { file }).apply {
            markWelcomed()
            setTheme(ThemeMode.DARK)
            setLanguage(AppLanguage.VI)
            setKeepScreenOn(false)
            setRetention(Retention.NONE)
        }
        first.coroutineContext[Job]!!.cancelAndJoin()
        val second = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val s = SettingsRepository(PreferenceDataStoreFactory.create(scope = second) { file }).settings.first()
        assertEquals(AppSettings(true, ThemeMode.DARK, AppLanguage.VI, false, Retention.NONE), s)
        second.cancel()
    }
}
