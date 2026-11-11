package app.shareanywhere.identity

/**
 * Where the device refresh secret lives between launches. The production store is [KeystoreSecretStore]
 * (AES-GCM key in AndroidKeyStore, docs/SECURITY_MODEL.md §4); the secret is never logged or kept in memory
 * longer than a refresh.
 */
interface SecretStore {
    suspend fun read(): String?

    suspend fun write(secret: String)

    suspend fun clear()
}
