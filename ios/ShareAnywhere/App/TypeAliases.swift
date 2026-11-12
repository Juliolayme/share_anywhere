import SAAPIClient
import SAStore

/// The app means the local History entry (SAStore) when it says `HistoryEntry`; the API's synced-entry model
/// (`SAAPIClient.HistoryEntry`, encrypted rows for cloud history sync) is named in full where it is used.
typealias HistoryEntry = SAStore.HistoryEntry
