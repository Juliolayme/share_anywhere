package auth

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func entryBody(entryID string, kv int) map[string]any {
	return map[string]any{"entry_id": entryID, "key_version": kv, "nonce": blob(12, 1), "ciphertext": blob(48, 2)}
}

// TestHistorySeqParallel: 50 parallel inserts get seq 1..50 with no gaps or duplicates, and a reader paging
// with the cursor while they run never skips or repeats an entry.
func TestHistorySeqParallel(t *testing.T) {
	e := newEnv(t)
	_, tokA := e.signup("quinn@example.com", true)
	_, tokB := e.signin("quinn@example.com", true)
	e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")
	idA, idB := e.ident(tokA), e.ident(tokB)

	const n = 50
	ids := make([]string, n)
	for i := range ids {
		ids[i] = newID()
	}
	seen := map[string]int64{}
	var order []int64
	done := make(chan struct{})
	readerErr := make(chan error, 1)
	go func() {
		after := int64(0)
		for {
			// Note whether every insert had committed BEFORE reading the page: only an empty page read after
			// that point proves the reader saw everything (checking after the read could stop one entry early).
			finished := false
			select {
			case <-done:
				finished = true
			default:
			}
			page, err := e.svc.Entries(ctx, idB, after, 7)
			if err != nil {
				readerErr <- err
				return
			}
			for _, en := range page.Entries {
				if _, dup := seen[en.EntryID]; dup {
					readerErr <- fmt.Errorf("entry %s read twice", en.EntryID)
					return
				}
				seen[en.EntryID] = en.Seq
				order = append(order, en.Seq)
			}
			after = page.NextAfter
			if finished && len(page.Entries) == 0 {
				readerErr <- nil
				return
			}
		}
	}()

	var wg sync.WaitGroup
	seqs := make([]int64, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			seqs[i], errs[i] = e.svc.AddEntry(ctx, idA, EntryInput{EntryID: ids[i], KeyVersion: 1, Nonce: blob(12, 1), Ciphertext: blob(48, byte(i))})
		}(i)
	}
	wg.Wait()
	close(done)
	if err := <-readerErr; err != nil {
		t.Fatal(err)
	}
	got := map[int64]bool{}
	for i, err := range errs {
		if err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
		if got[seqs[i]] {
			t.Fatalf("duplicate seq %d", seqs[i])
		}
		got[seqs[i]] = true
	}
	for s := int64(1); s <= n; s++ {
		if !got[s] {
			t.Fatalf("gap: seq %d missing", s)
		}
	}
	if len(seen) != n {
		t.Fatalf("cursor reader saw %d of %d entries", len(seen), n)
	}
	for i := 1; i < len(order); i++ {
		if order[i] <= order[i-1] {
			t.Fatalf("reader order not increasing: %v", order)
		}
	}
}

func TestHistoryIdempotentAndTombstones(t *testing.T) {
	e := newEnv(t)
	a, tokA := e.signup("ray@example.com", true)
	_, tokB := e.signin("ray@example.com", true)
	_, other := e.signup("sam@example.com", true)

	id1, id2, id3 := newID(), newID(), newID()
	// No ADK yet: key_version 1 is ahead of the account.
	e.want(e.do("POST", "/v1/history/entries", tokA, entryBody(id1, 1)), 409, "key_version_conflict")
	e.want(e.do("POST", "/v1/keys/setup", tokA, setupBody()), 201, "")
	e.want(e.do("POST", "/v1/history/entries", tokA, entryBody(id1, 2)), 409, "key_version_conflict")
	for _, bad := range []map[string]any{
		{"entry_id": "not-a-uuid", "key_version": 1, "nonce": blob(12, 1), "ciphertext": blob(48, 2)},
		{"entry_id": id1, "key_version": 1, "nonce": blob(11, 1), "ciphertext": blob(48, 2)},
		{"entry_id": id1, "key_version": 1, "nonce": blob(12, 1), "ciphertext": blob(64<<10+1, 2)},
		{"entry_id": id1, "key_version": 0, "nonce": blob(12, 1), "ciphertext": blob(48, 2)},
	} {
		e.want(e.do("POST", "/v1/history/entries", tokA, bad), 400, "invalid_request")
	}
	r1 := e.do("POST", "/v1/history/entries", tokA, entryBody(id1, 1))
	e.want(r1, 201, "")
	again := e.do("POST", "/v1/history/entries", tokB, entryBody(id1, 1))
	e.want(again, 201, "")
	if r1.body["seq"] != again.body["seq"] || r1.body["seq"].(float64) != 1 {
		t.Fatalf("idempotent insert: %s vs %s", r1.raw, again.raw)
	}
	e.want(e.do("POST", "/v1/history/entries", tokB, entryBody(id2, 1)), 201, "")
	e.want(e.do("POST", "/v1/history/entries", tokA, entryBody(id3, 1)), 201, "")

	page := e.do("GET", "/v1/history/entries?after=0&limit=2", tokB, nil)
	e.want(page, 200, "")
	if es := page.body["entries"].([]any); len(es) != 2 || page.body["next_after"].(float64) != 2 {
		t.Fatalf("page: %s", page.raw)
	}
	first := page.body["entries"].([]any)[0].(map[string]any)
	if first["entry_id"] != id1 || first["origin_device_id"] != a.Device.ID || first["nonce"] != blob(12, 1) || first["deleted"] != false {
		t.Fatalf("entry: %v", first)
	}
	e.want(e.do("GET", "/v1/history/entries?limit=501", tokB, nil), 400, "invalid_request")
	e.want(e.do("GET", "/v1/history/entries?after=-1", tokB, nil), 400, "invalid_request")
	// Other accounts see nothing.
	if es := e.do("GET", "/v1/history/entries", other, nil).body["entries"].([]any); len(es) != 0 {
		t.Fatal("history leaked across accounts")
	}
	e.want(e.do("DELETE", "/v1/history/entries/"+id1, other, nil), 404, "not_found")

	// Delete: tombstone with a new seq; a reader at the cursor sees it once.
	e.want(e.do("DELETE", "/v1/history/entries/"+id1, tokB, nil), 204, "")
	e.want(e.do("DELETE", "/v1/history/entries/"+id1, tokB, nil), 204, "")
	e.want(e.do("DELETE", "/v1/history/entries/"+newID(), tokB, nil), 404, "not_found")
	r := e.do("GET", "/v1/history/entries?after=3", tokA, nil)
	es := r.body["entries"].([]any)
	if len(es) != 1 {
		t.Fatalf("tombstone: %s", r.raw)
	}
	tomb := es[0].(map[string]any)
	if tomb["entry_id"] != id1 || tomb["deleted"] != true || tomb["seq"].(float64) != 4 || tomb["ciphertext"] != nil || tomb["nonce"] != nil {
		t.Fatalf("tombstone: %v", tomb)
	}
	// Re-posting a deleted entry does not resurrect it.
	if r := e.do("POST", "/v1/history/entries", tokA, entryBody(id1, 1)); r.body["seq"].(float64) != 4 {
		t.Fatalf("repost of deleted entry: %s", r.raw)
	}

	// After a rotation new entries must use the current version (docs/ADR/0015-authenticated-recovery-key.md):
	// an older one is 409 key_version_conflict and nothing is stored, the current one is accepted, and a retry of
	// an entry already stored still returns its original seq.
	e.want(e.do("PUT", "/v1/keys/device", tokA, deviceKeyBody(a.Device.ID, 1, pub32(1))), 204, "") // a rotating device holds a key proven at the current version
	e.want(e.do("POST", "/v1/keys/rotate", tokA, rotateBody(2, adk(1), 4, nil)), 200, "")
	idOld := newID()
	e.want(e.do("POST", "/v1/history/entries", tokB, entryBody(idOld, 1)), 409, "key_version_conflict")
	e.want(e.do("POST", "/v1/history/entries", tokB, entryBody(newID(), 3)), 409, "key_version_conflict")
	var stored int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM history_entries WHERE entry_id = $1::uuid`, idOld).Scan(&stored)
	if stored != 0 {
		t.Fatal("an entry under an old key version was stored")
	}
	if r := e.do("POST", "/v1/history/entries", tokA, entryBody(id2, 1)); r.code != 201 || r.body["seq"].(float64) != 2 {
		t.Fatalf("idempotent retry of an entry stored before the rotation: %s", r.raw)
	}
	r2 := e.do("POST", "/v1/history/entries", tokB, entryBody(idOld, 2))
	e.want(r2, 201, "")
	if r2.body["seq"].(float64) != 5 {
		t.Fatalf("entry under the current version: %s", r2.raw)
	}

	// Clear: every live entry becomes a tombstone with a new seq.
	e.want(e.do("DELETE", "/v1/history", tokA, nil), 204, "")
	r = e.do("GET", "/v1/history/entries?after=5", tokB, nil)
	es = r.body["entries"].([]any)
	if len(es) != 3 || r.body["next_after"].(float64) != 8 {
		t.Fatalf("clear: %s", r.raw)
	}
	for _, x := range es {
		if x.(map[string]any)["deleted"] != true {
			t.Fatalf("clear left a live entry: %v", x)
		}
	}
	var live int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM history_entries WHERE ciphertext IS NOT NULL`).Scan(&live)
	if live != 0 {
		t.Fatalf("%d entries still hold ciphertext", live)
	}
}

func TestSweepEndsExpiredSessions(t *testing.T) {
	e := newEnv(t)
	_, tok := e.signin2("tess@example.com")
	b := e.ident(tok)
	e.clk.Advance(25 * time.Hour)
	if err := e.svc.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	var revoked int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE device_id = $1::uuid AND revoked_at IS NOT NULL`, b.DeviceID).Scan(&revoked)
	if revoked != 1 {
		t.Fatal("sweep must end the expired not-added session")
	}
}

// signin2 signs up on one device and signs in (not added) on another, returning the second.
func (e *env) signin2(email string) (string, string) {
	e.signup(email, true)
	d, tok := e.signin(email, false)
	return d.Device.ID, tok
}
