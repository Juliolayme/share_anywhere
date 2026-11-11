package app.shareanywhere.di

import android.content.Context
import android.os.Build
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.room.Room
import app.shareanywhere.account.AccountDataHooks
import app.shareanywhere.account.AccountManager
import app.shareanywhere.account.keys.AccountKeyStore
import app.shareanywhere.account.keys.AccountKeys
import app.shareanywhere.account.keys.SyncMeta
import app.shareanywhere.account.sync.FileHistoryMetaStore
import app.shareanywhere.account.sync.HistoryMetaStore
import app.shareanywhere.clipboard.ClipboardApi
import app.shareanywhere.clipboard.ClipboardDatabase
import app.shareanywhere.clipboard.ClipboardEndpoints
import app.shareanywhere.clipboard.ClipboardRuntime
import app.shareanywhere.clipboard.ClipboardStore
import app.shareanywhere.config.AppConfig
import app.shareanywhere.data.api.AccountApi
import app.shareanywhere.data.api.ApiClient
import app.shareanywhere.data.api.DeviceApi
import app.shareanywhere.data.api.SessionsApi
import app.shareanywhere.data.api.TransfersApi
import app.shareanywhere.data.ws.SessionSocket
import app.shareanywhere.history.HistoryDao
import app.shareanywhere.history.HistoryDatabase
import app.shareanywhere.history.HistoryRepository
import app.shareanywhere.identity.IdentityManager
import app.shareanywhere.identity.KeystoreSecretStore
import app.shareanywhere.identity.SecretStore
import app.shareanywhere.notify.Notifier
import app.shareanywhere.settings.SettingsRepository
import app.shareanywhere.sharing.JoinFlow
import app.shareanywhere.sharing.OutgoingStore
import app.shareanywhere.sharing.PickedFiles
import app.shareanywhere.transfer.IncomingDao
import app.shareanywhere.transfer.OutgoingFileDao
import app.shareanywhere.transfer.TransferDatabase
import app.shareanywhere.transfer.runtime.TransferRuntime
import app.shareanywhere.ui.keepawake.KeepAwakeController
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import java.util.concurrent.TimeUnit
import javax.inject.Provider
import javax.inject.Qualifier
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient

/** Process-wide scope for work that outlives screens (identity bootstrap and refresh). */
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class AppScope

@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    @Provides @Singleton
    fun config(): AppConfig = AppConfig.fromBuildConfig()

    @Provides @Singleton @AppScope
    fun appScope(): CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    @Provides @Singleton
    fun json(): Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    @Provides @Singleton
    fun okHttp(): OkHttpClient = OkHttpClient
        .Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    @Provides @Singleton
    fun apiClient(config: AppConfig, http: OkHttpClient, json: Json): ApiClient = ApiClient(
        baseUrl = config.backendUrl,
        http = http,
        json = json,
        requireHttps = !config.debug,
        userAgent = "ShareAnywhere-Android/${config.versionName}"
    )

    @Provides @Singleton
    fun deviceApi(client: ApiClient): DeviceApi = DeviceApi(client)

    @Provides @Singleton
    fun secretStore(@ApplicationContext context: Context): SecretStore = KeystoreSecretStore(context)

    @Provides @Singleton
    fun identity(api: DeviceApi, store: SecretStore, @AppScope scope: CoroutineScope): IdentityManager =
        IdentityManager(api, store, platformLabel(), scope)

    @Provides @Singleton
    fun historyDatabase(@ApplicationContext context: Context): HistoryDatabase =
        Room.databaseBuilder(context, HistoryDatabase::class.java, HistoryDatabase.NAME).build()

    @Provides
    fun historyDao(db: HistoryDatabase): HistoryDao = db.history()

    @Provides @Singleton
    fun historyRepository(dao: HistoryDao): HistoryRepository = HistoryRepository(dao)

    @Provides @Singleton
    fun dataStore(@ApplicationContext context: Context): DataStore<Preferences> =
        PreferenceDataStoreFactory.create { context.preferencesDataStoreFile(SettingsRepository.FILE) }

    @Provides @Singleton
    fun settings(store: DataStore<Preferences>): SettingsRepository = SettingsRepository(store)

    @Provides @Singleton
    fun sessionsApi(client: ApiClient, identity: IdentityManager): SessionsApi = SessionsApi(client, identity)

    @Provides @Singleton
    fun sessionSocket(config: AppConfig, http: OkHttpClient, json: Json, api: SessionsApi, @AppScope scope: CoroutineScope): SessionSocket =
        SessionSocket(config.backendUrl, http, json, scope, ticket = { api.wsTicket().ticket })

    @Provides @Singleton
    fun transferDatabase(@ApplicationContext context: Context): TransferDatabase = Room.databaseBuilder(
        context,
        TransferDatabase::class.java,
        TransferDatabase.NAME
    ).addMigrations(TransferDatabase.MIGRATION_1_2).build()

    @Provides
    fun outgoingFiles(db: TransferDatabase): OutgoingFileDao = db.outgoing()

    @Provides
    fun incoming(db: TransferDatabase): IncomingDao = db.incoming()

    @Provides @Singleton
    fun transfersApi(client: ApiClient, identity: IdentityManager): TransfersApi = TransfersApi(client, identity)

    @Provides @Singleton
    fun transferRuntime(
        @ApplicationContext context: Context,
        sessions: SessionsApi,
        transfers: TransfersApi,
        socket: SessionSocket,
        outgoing: OutgoingFileDao,
        incoming: IncomingDao,
        history: HistoryRepository,
        json: Json,
        @AppScope scope: CoroutineScope
    ): TransferRuntime = TransferRuntime(context, sessions, transfers, socket, outgoing, incoming, history, json, scope)

    @Provides @Singleton
    fun pickedFiles(@ApplicationContext context: Context): PickedFiles = PickedFiles(context.contentResolver)

    @Provides @Singleton
    fun outgoingStore(dao: OutgoingFileDao, picked: PickedFiles): OutgoingStore = OutgoingStore(dao, picked)

    @Provides @Singleton
    fun joinFlow(): JoinFlow = JoinFlow()

    @Provides @Singleton
    fun notifier(@ApplicationContext context: Context): Notifier = Notifier(context)

    @Provides @Singleton
    fun keepAwake(): KeepAwakeController = KeepAwakeController()

    // --- Accounts (milestone 6.4) ---

    @Provides @Singleton
    fun accountApi(client: ApiClient, identity: IdentityManager): AccountApi = AccountApi(client, identity)

    @Provides @Singleton
    fun accountKeyStore(@ApplicationContext context: Context): AccountKeyStore = AccountKeyStore(context)

    @Provides @Singleton
    fun syncMeta(@ApplicationContext context: Context): SyncMeta = SyncMeta(context)

    @Provides @Singleton
    fun accountKeys(api: AccountApi, store: AccountKeyStore, meta: SyncMeta): AccountKeys = AccountKeys(api, store, meta)

    @Provides @Singleton
    fun historyMeta(@ApplicationContext context: Context): HistoryMetaStore = FileHistoryMetaStore(context.noBackupFilesDir)

    @Provides @Singleton
    fun accountManager(
        identity: IdentityManager,
        api: AccountApi,
        keys: AccountKeys,
        history: HistoryRepository,
        historyMeta: HistoryMetaStore,
        clipboard: Provider<ClipboardRuntime>,
        @AppScope scope: CoroutineScope
    ): AccountManager = AccountManager(
        identity,
        api,
        keys,
        history,
        historyMeta,
        scope,
        onAccountData =
        object : AccountDataHooks() {
            override suspend fun wipe() = clipboard.get().wipe()

            override suspend fun keysChanged() = clipboard.get().keysChanged()
        },
        foreground = {
            androidx.lifecycle.ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)
        }
    )

    // --- Clipboard Sync (milestone 6.4) ---

    @Provides @Singleton
    fun clipboardDatabase(@ApplicationContext context: Context): ClipboardDatabase =
        Room.databaseBuilder(context, ClipboardDatabase::class.java, ClipboardDatabase.NAME).build()

    @Provides @Singleton
    fun clipboardStore(db: ClipboardDatabase): ClipboardStore = ClipboardStore(db.clipboard())

    @Provides @Singleton
    fun clipboardApi(client: ApiClient, identity: IdentityManager): ClipboardEndpoints = ClipboardApi(client, identity)

    @Provides @Singleton
    fun clipboardRuntime(
        @ApplicationContext context: Context,
        account: AccountManager,
        api: ClipboardEndpoints,
        store: ClipboardStore,
        socket: SessionSocket,
        settings: SettingsRepository,
        @AppScope scope: CoroutineScope
    ): ClipboardRuntime = ClipboardRuntime(context, account, api, store, socket, settings, scope)

    /** "Android · Pixel 7": the server adds two random words to make the display name (PRD §5.1). */
    fun platformLabel(model: String = Build.MODEL.orEmpty()): String =
        model.trim().let { if (it.isEmpty()) "Android" else "Android · $it" }.take(60)
}
