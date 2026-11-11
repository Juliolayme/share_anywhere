package clipboard

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestSeqParallelCursor: 50 parallel inserts get seq 1..50 with no gaps or duplicates, and a reader paging
// with the cursor while they run never skips or repeats an event.
func TestSeqParallelCursor(t *testing.T) {
	e := newEnv(t, 100)
	_, tokA := e.signup("ada@example.com")
	_, tokB := e.signin("ada@example.com", true)
	idA, idB := e.ident(tokA), e.ident(tokB)

	const n = 50
	seen := map[string]int64{}
	var order []int64
	done := make(chan struct{})
	readerErr := make(chan error, 1)
	go func() {
		cursor := int64(0)
		for {
			// Only an empty page read after every insert committed proves the reader saw everything.
			finished := false
			select {
			case <-done:
				finished = true
			default:
			}
			page, err := e.svc.Events(ctx, idB, cursor, 7)
			if err != nil {
				readerErr <- err
				return
			}
			for _, ev := range page.Events {
				if _, dup := seen[ev.EventID]; dup {
					readerErr <- fmt.Errorf("event %s read twice", ev.EventID)
					return
				}
				seen[ev.EventID] = ev.Seq
				order = append(order, ev.Seq)
			}
			cursor = page.NextCursor
			if finished && len(page.Events) == 0 {
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
			out, err := e.svc.Create(ctx, idA, input(newID(), 1))
			seqs[i], errs[i] = out.Seq, err
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
		t.Fatalf("cursor reader saw %d of %d events", len(seen), n)
	}
	for i := 1; i < len(order); i++ {
		if order[i] <= order[i-1] {
			t.Fatalf("reader order not increasing: %v", order)
		}
	}
	// The reader's cursor was recorded and never moves backwards.
	if c := e.count(`SELECT last_seq FROM clipboard_device_cursors WHERE device_id = $1::uuid`, idB.DeviceID); c != n {
		t.Fatalf("recorded cursor %d, want %d", c, n)
	}
	e.want(e.do("GET", "/v1/clipboard/events?cursor=3", tokB, nil), 200, "")
	if c := e.count(`SELECT last_seq FROM clipboard_device_cursors WHERE device_id = $1::uuid`, idB.DeviceID); c != n {
		t.Fatalf("cursor moved backwards to %d", c)
	}
	// A cursor beyond the account's highest seq is recorded as that seq.
	e.want(e.do("GET", "/v1/clipboard/events?cursor=9999", tokA, nil), 200, "")
	if c := e.count(`SELECT last_seq FROM clipboard_device_cursors WHERE device_id = $1::uuid`, idA.DeviceID); c != n {
		t.Fatalf("cursor past the end recorded as %d", c)
	}
}

func TestIdempotentEventsTombstonesAndValidation(t *testing.T) {
	e := newEnv(t, 100)
	a, tokA := e.signup("bea@example.com")
	_, tokB := e.signin("bea@example.com", true)
	_, other := e.signup("cal@example.com")

	id1, id2, id3 := newID(), newID(), newID()
	for _, bad := range []map[string]any{
		{"event_id": "not-a-uuid", "key_version": 1, "nonce": blob(12, 1), "ciphertext": blob(48, 2), "payload_size": 32},
		{"event_id": id1, "key_version": 1, "nonce": blob(11, 1), "ciphertext": blob(48, 2), "payload_size": 32},
		{"event_id": id1, "key_version": 0, "nonce": blob(12, 1), "ciphertext": blob(48, 2), "payload_size": 32},
		{"event_id": id1, "key_version": 1, "nonce": blob(12, 1), "ciphertext": blob(16, 2), "payload_size": 32},
		{"event_id": id1, "key_version": 1, "nonce": blob(12, 1), "ciphertext": blob(48, 2), "payload_size": 0},
		{"event_id": id1, "key_version": 1, "nonce": blob(12, 1), "ciphertext": "a+b/", "payload_size": 32},
		{"event_id": id1, "key_version": 1, "nonce": blob(12, 1), "ciphertext": blob(48, 2), "payload_size": 32, "event_type": "IMAGE"},
		{"event_id": id1, "key_version": 1, "nonce": blob(12, 1), "ciphertext": blob(48, 2), "payload_size": 32, "mime_type": "text/html"},
		{"event_id": id1, "key_version": 1, "nonce": blob(12, 1), "ciphertext": blob(48, 2), "payload_size": 32, "extra": true},
		{"event_id": id1, "key_version": 1, "nonce": blob(12, 1), "ciphertext": blob(48, 2)},
		// v1: the ciphertext is exactly payload_size + the 16-byte tag.
		{"event_id": id1, "key_version": 1, "nonce": blob(12, 1), "ciphertext": blob(48, 2), "payload_size": 31},
		{"event_id": id1, "key_version": 1, "nonce": blob(12, 1), "ciphertext": blob(48, 2), "payload_size": 33},
		{"event_id": id1, "key_version": 1, "nonce": blob(12, 1), "ciphertext": blob(32, 2), "payload_size": 32},
	} {
		e.want(e.do("POST", "/v1/clipboard/events", tokA, bad), 400, "invalid_request")
	}
	body := eventBody(id1, 1, 32)
	body["event_type"], body["mime_type"] = "TEXT", "text/plain"
	r1 := e.do("POST", "/v1/clipboard/events", tokA, body)
	e.want(r1, 201, "")
	if r1.body["seq"].(float64) != 1 || r1.str("created_at") != t0.Format(time.RFC3339) || r1.str("expires_at") != t0.Add(7*24*time.Hour).Format(time.RFC3339) {
		t.Fatalf("create: %s", r1.raw)
	}
	// The same event_id from another device (an offline retry) returns the stored values and stores nothing.
	again := e.do("POST", "/v1/clipboard/events", tokB, eventBody(id1, 1, 99))
	e.want(again, 201, "")
	if again.raw != r1.raw {
		t.Fatalf("idempotent insert: %s vs %s", r1.raw, again.raw)
	}
	if c := e.count(`SELECT count(*) FROM clipboard_events`); c != 1 {
		t.Fatalf("%d rows after a retry", c)
	}
	e.want(e.do("POST", "/v1/clipboard/events", tokB, eventBody(id2, 1, 10)), 201, "")
	e.want(e.do("POST", "/v1/clipboard/events", tokA, eventBody(id3, 1, 20)), 201, "")

	page := e.do("GET", "/v1/clipboard/events?cursor=0&limit=2", tokB, nil)
	e.want(page, 200, "")
	evs := page.body["events"].([]any)
	if len(evs) != 2 || page.body["next_cursor"].(float64) != 2 {
		t.Fatalf("page: %s", page.raw)
	}
	first := evs[0].(map[string]any)
	if first["event_id"] != id1 || first["origin_device_id"] != a.Device.ID || first["nonce"] != blob(12, 1) || first["ciphertext"] != blob(48, 2) ||
		first["deleted"] != false || first["event_type"] != "TEXT" || first["mime_type"] != "text/plain" || first["payload_size"].(float64) != 32 ||
		first["key_version"].(float64) != 1 || first["expires_at"] != t0.Add(7*24*time.Hour).Format(time.RFC3339) {
		t.Fatalf("event: %v", first)
	}
	e.want(e.do("GET", "/v1/clipboard/events?limit=201", tokB, nil), 400, "invalid_request")
	e.want(e.do("GET", "/v1/clipboard/events?limit=0", tokB, nil), 400, "invalid_request")
	e.want(e.do("GET", "/v1/clipboard/events?cursor=-1", tokB, nil), 400, "invalid_request")
	e.want(e.do("GET", "/v1/clipboard/history?limit=101", tokB, nil), 400, "invalid_request")
	// Other accounts see nothing and cannot delete.
	if es := e.do("GET", "/v1/clipboard/events", other, nil).body["events"].([]any); len(es) != 0 {
		t.Fatal("clipboard leaked across accounts")
	}
	if h := e.do("GET", "/v1/clipboard/history", other, nil); len(h.body["events"].([]any)) != 0 || h.body["cursor"].(float64) != 0 {
		t.Fatalf("other account history: %s", h.raw)
	}
	e.want(e.do("DELETE", "/v1/clipboard/events/"+id1, other, nil), 404, "not_found")
	e.want(e.do("DELETE", "/v1/clipboard/events/not-a-uuid", tokA, nil), 400, "invalid_request")

	// History: live events newest first, with the current highest seq as the cursor.
	h := e.do("GET", "/v1/clipboard/history", tokB, nil)
	e.want(h, 200, "")
	hs := h.body["events"].([]any)
	if len(hs) != 3 || hs[0].(map[string]any)["event_id"] != id3 || hs[2].(map[string]any)["event_id"] != id1 || h.body["cursor"].(float64) != 3 {
		t.Fatalf("history: %s", h.raw)
	}

	// Delete: a tombstone with a new seq and no ciphertext; a reader at the cursor sees it once.
	e.want(e.do("DELETE", "/v1/clipboard/events/"+id1, tokB, nil), 204, "")
	e.want(e.do("DELETE", "/v1/clipboard/events/"+id1, tokB, nil), 204, "")
	e.want(e.do("DELETE", "/v1/clipboard/events/"+newID(), tokB, nil), 404, "not_found")
	r := e.do("GET", "/v1/clipboard/events?cursor=3", tokA, nil)
	es := r.body["events"].([]any)
	if len(es) != 1 || r.body["next_cursor"].(float64) != 4 {
		t.Fatalf("tombstone: %s", r.raw)
	}
	tomb := es[0].(map[string]any)
	if tomb["event_id"] != id1 || tomb["deleted"] != true || tomb["seq"].(float64) != 4 || tomb["ciphertext"] != nil || tomb["nonce"] != nil {
		t.Fatalf("tombstone: %v", tomb)
	}
	if !strings.Contains(r.raw, `"nonce":null`) || !strings.Contains(r.raw, `"ciphertext":null`) {
		t.Fatalf("tombstones carry explicit nulls: %s", r.raw)
	}
	// Re-posting a deleted event returns its seq without restoring it.
	if r := e.do("POST", "/v1/clipboard/events", tokA, eventBody(id1, 1, 32)); r.code != 201 || r.body["seq"].(float64) != 4 {
		t.Fatalf("repost of a deleted event: %s", r.raw)
	}
	if c := e.count(`SELECT count(*) FROM clipboard_events WHERE event_id = $1::uuid AND deleted_at IS NULL`, id1); c != 0 {
		t.Fatal("a deleted event was restored")
	}

	// Clear: every live event becomes a tombstone with a new seq.
	e.want(e.do("DELETE", "/v1/clipboard/history", tokA, nil), 204, "")
	r = e.do("GET", "/v1/clipboard/events?cursor=4", tokB, nil)
	es = r.body["events"].([]any)
	if len(es) != 2 || r.body["next_cursor"].(float64) != 6 {
		t.Fatalf("clear: %s", r.raw)
	}
	for _, x := range es {
		if x.(map[string]any)["deleted"] != true {
			t.Fatalf("clear left a live event: %v", x)
		}
	}
	if c := e.count(`SELECT count(*) FROM clipboard_events WHERE ciphertext IS NOT NULL OR nonce IS NOT NULL`); c != 0 {
		t.Fatalf("%d events still hold ciphertext", c)
	}
	if h := e.do("GET", "/v1/clipboard/history", tokB, nil); len(h.body["events"].([]any)) != 0 || h.body["cursor"].(float64) != 6 {
		t.Fatalf("history after clear: %s", h.raw)
	}
	e.want(e.do("DELETE", "/v1/clipboard/history", tokA, nil), 204, "") // nothing to clear
	e.want(e.do("PATCH", "/v1/clipboard/history", tokA, nil), 405, "method_not_allowed")
}

// TestPayloadLimits: payload_size above 256 KB, ciphertext above 256 KB + tag, or a body too large to hold
// either is 413 payload_too_large; exactly 256 KB is accepted.
func TestPayloadLimits(t *testing.T) {
	e := newEnv(t, 100)
	_, tok := e.signup("dee@example.com")
	b := eventBody(newID(), 1, 32)
	b["payload_size"] = MaxPayload + 1
	e.want(e.do("POST", "/v1/clipboard/events", tok, b), 413, "payload_too_large")
	b = eventBody(newID(), 1, 32)
	b["ciphertext"] = blob(MaxCiphertext+1, 3)
	e.want(e.do("POST", "/v1/clipboard/events", tok, b), 413, "payload_too_large")
	huge := []byte(`{"event_id":"` + newID() + `","key_version":1,"nonce":"` + blob(12, 1) + `","payload_size":10,"ciphertext":"` +
		strings.Repeat("A", maxEventBody) + `"}`)
	e.want(e.do("POST", "/v1/clipboard/events", tok, huge), 413, "payload_too_large")
	if c := e.count(`SELECT count(*) FROM clipboard_events`); c != 0 {
		t.Fatalf("%d oversized events stored", c)
	}
	e.want(e.do("POST", "/v1/clipboard/events", tok, eventBody(newID(), 1, MaxPayload)), 201, "")
}

// TestPayloadSizeMatchesCiphertext (QA round 1): for v1 the ciphertext must be exactly payload_size plus the
// 16-byte AES-GCM tag; any other length is 400 invalid_request and nothing is stored.
func TestPayloadSizeMatchesCiphertext(t *testing.T) {
	e := newEnv(t, 100)
	_, tok := e.signup("fay@example.com")
	for _, c := range []struct{ ct, size int }{{17, 2}, {17, 0}, {100, 100}, {100, 83}, {100, 85}, {MaxCiphertext, MaxPayload - 1}} {
		b := eventBody(newID(), 1, 1)
		b["ciphertext"], b["payload_size"] = blob(c.ct, 2), c.size
		e.want(e.do("POST", "/v1/clipboard/events", tok, b), 400, "invalid_request")
	}
	if c := e.count(`SELECT count(*) FROM clipboard_events`); c != 0 {
		t.Fatalf("%d mismatched events stored", c)
	}
	for _, n := range []int{1, 84, MaxPayload} {
		e.want(e.do("POST", "/v1/clipboard/events", tok, eventBody(newID(), 1, n)), 201, "")
	}
}

// TestCanonicalEventIDs (QA round 1): event_id is part of the AAD, so only the lowercase canonical
// 8-4-4-4-12 form is accepted; uppercase, braces, no hyphens, and URN forms are 400 invalid_request on POST and
// on DELETE by id, and the stored id comes back in the same lowercase form.
func TestCanonicalEventIDs(t *testing.T) {
	e := newEnv(t, 100)
	_, tok := e.signup("gus@example.com")
	id := newID()
	bads := []string{
		strings.ToUpper(id),
		id[:35] + "A",
		"{" + id + "}",
		strings.ReplaceAll(id, "-", ""),
		"urn:uuid:" + id,
		id[:8] + "_" + id[9:],
	}
	for _, bad := range bads {
		e.want(e.do("POST", "/v1/clipboard/events", tok, eventBody(bad, 1, 8)), 400, "invalid_request")
	}
	if c := e.count(`SELECT count(*) FROM clipboard_events`); c != 0 {
		t.Fatalf("%d events stored from non-canonical ids", c)
	}
	e.want(e.do("POST", "/v1/clipboard/events", tok, eventBody(id, 1, 8)), 201, "")
	for _, path := range []string{"/v1/clipboard/events", "/v1/clipboard/history"} {
		r := e.do("GET", path, tok, nil)
		if es := r.body["events"].([]any); len(es) != 1 || es[0].(map[string]any)["event_id"] != id {
			t.Fatalf("%s: event_id not in canonical form: %s", path, r.raw)
		}
	}
	for _, bad := range bads {
		e.want(e.do("DELETE", "/v1/clipboard/events/"+url.PathEscape(bad), tok, nil), 400, "invalid_request")
	}
	if c := e.count(`SELECT count(*) FROM clipboard_events WHERE deleted_at IS NULL`); c != 1 {
		t.Fatal("a non-canonical DELETE removed the event")
	}
	e.want(e.do("DELETE", "/v1/clipboard/events/"+id, tok, nil), 204, "")
}

// TestClearRacingSweep (QA round 1): Clear (and Delete) running at the same time as the retention sweep over
// expired-but-unswept events never deadlocks or fails, and the account's sequence stays consistent: the sweep
// skips rows a writer holds (FOR UPDATE SKIP LOCKED) and Clear renumbers exactly the rows it locked.
func TestClearRacingSweep(t *testing.T) {
	e := newEnv(t, 100)
	_, tok := e.signup("hal@example.com")
	id := e.ident(tok)
	// Retention 1 day keeps the 40 iterations well inside the account session's lifetime; from the eighth
	// iteration on, the sweep also removes earlier tombstones while Clear runs.
	e.want(e.do("PUT", "/v1/clipboard/settings", tok, map[string]any{"paused": false, "retention_days": 1, "sensitive_skip": true}), 200, "")
	var last int64
	for i := 0; i < 40; i++ {
		// Six events that will be expired, then three fresh ones.
		var doomed string
		for j := 0; j < 6; j++ {
			evID := newID()
			if _, err := e.svc.Create(ctx, id, input(evID, 1)); err != nil {
				t.Fatalf("iteration %d: create: %v", i, err)
			}
			doomed = evID
		}
		e.clk.Advance(25 * time.Hour)
		for j := 0; j < 3; j++ {
			if _, err := e.svc.Create(ctx, id, input(newID(), 1)); err != nil {
				t.Fatalf("iteration %d: create fresh: %v", i, err)
			}
		}
		var wg sync.WaitGroup
		var clearErr, sweepErr, delErr error
		wg.Add(3)
		go func() { defer wg.Done(); clearErr = e.svc.Clear(ctx, id) }()
		go func() { defer wg.Done(); _, sweepErr = e.svc.Sweep(ctx) }()
		go func() {
			defer wg.Done()
			if err := e.svc.Delete(ctx, id, doomed); err != nil && !errors.Is(err, ErrNotFound) {
				delErr = err
			}
		}()
		wg.Wait()
		if clearErr != nil || sweepErr != nil || delErr != nil {
			t.Fatalf("iteration %d: clear %v, sweep %v, delete %v", i, clearErr, sweepErr, delErr)
		}
		if c := e.count(`SELECT count(*) FROM clipboard_events WHERE deleted_at IS NULL`); c != 0 {
			t.Fatalf("iteration %d: %d live events after Clear", i, c)
		}
		var maxSeq, lastSeq int64
		if err := e.pool.QueryRow(ctx, `SELECT COALESCE(MAX(e.seq), 0), s.last_seq FROM clipboard_settings s
			LEFT JOIN clipboard_events e ON e.user_id = s.user_id GROUP BY s.last_seq`).Scan(&maxSeq, &lastSeq); err != nil {
			t.Fatal(err)
		}
		if maxSeq > lastSeq || lastSeq < last {
			t.Fatalf("iteration %d: max seq %d, last_seq %d (was %d)", i, maxSeq, lastSeq, last)
		}
		// The next event continues the sequence without colliding with a renumbered row.
		out, err := e.svc.Create(ctx, id, input(newID(), 1))
		if err != nil || out.Seq != lastSeq+1 {
			t.Fatalf("iteration %d: next create seq %d (want %d): %v", i, out.Seq, lastSeq+1, err)
		}
		last = out.Seq
	}
}

// TestCapAndRetentionSweep: the 101st live event tombstones the oldest; the sweep hard-deletes expired events
// and old tombstones; seq values are never reused after rows are removed; retention applies to new events.
func TestCapAndRetentionSweep(t *testing.T) {
	e := newEnv(t, 100)
	_, tok := e.signup("eve@example.com")
	id := e.ident(tok)
	ids := make([]string, MaxLive+1)
	for i := range ids {
		ids[i] = newID()
		out, err := e.svc.Create(ctx, id, input(ids[i], 1))
		if err != nil {
			t.Fatal(err)
		}
		if i < MaxLive && out.Seq != int64(i+1) {
			t.Fatalf("seq %d for insert %d", out.Seq, i)
		}
		if i == MaxLive && out.Seq != MaxLive+1 {
			t.Fatalf("101st insert got seq %d", out.Seq)
		}
	}
	if c := e.count(`SELECT count(*) FROM clipboard_events WHERE deleted_at IS NULL`); c != MaxLive {
		t.Fatalf("%d live events, want %d", c, MaxLive)
	}
	var deletedSeq int64
	if err := e.pool.QueryRow(ctx, `SELECT seq FROM clipboard_events WHERE event_id = $1::uuid AND deleted_at IS NOT NULL AND ciphertext IS NULL`, ids[0]).Scan(&deletedSeq); err != nil {
		t.Fatalf("the oldest event must be a tombstone: %v", err)
	}
	if deletedSeq != MaxLive+2 {
		t.Fatalf("cap tombstone seq %d", deletedSeq)
	}
	h, err := e.svc.History(ctx, id, 100)
	if err != nil || len(h.Events) != MaxLive || h.Events[0].EventID != ids[MaxLive] || h.Events[MaxLive-1].EventID != ids[1] || h.Cursor != MaxLive+2 {
		t.Fatalf("history after cap: %d events, cursor %d, %v", len(h.Events), h.Cursor, err)
	}

	// Retention 1 day applies to events created from now on.
	e.want(e.do("PUT", "/v1/clipboard/settings", tok, map[string]any{"paused": false, "retention_days": 1, "sensitive_skip": true}), 200, "")
	e.clk.Advance(time.Hour)
	short, err := e.svc.Create(ctx, id, input(newID(), 1))
	if err != nil || !short.ExpiresAt.Equal(short.CreatedAt.Add(24*time.Hour)) {
		t.Fatalf("retention 1 day: %+v %v", short, err)
	}
	// Past one day the short event is left out of reads before the sweep removes it.
	e.clk.Advance(25 * time.Hour)
	h, _ = e.svc.History(ctx, id, 100)
	for _, ev := range h.Events {
		if ev.Seq == short.Seq {
			t.Fatal("an expired event is still listed")
		}
	}
	page, _ := e.svc.Events(ctx, id, short.Seq-1, 10)
	for _, ev := range page.Events {
		if ev.Seq == short.Seq {
			t.Fatalf("expired event in the cursor feed: %+v", ev)
		}
	}
	// (short's insert was the 101st live event again, so the feed holds the tombstone of ids[1].)
	if len(page.Events) != 1 || page.Events[0].EventID != ids[1] || !page.Events[0].Deleted {
		t.Fatalf("cursor feed after short: %+v", page.Events)
	}
	res, err := e.svc.Sweep(ctx)
	if err != nil || res.Expired != 1 || res.Tombstones != 0 {
		t.Fatalf("sweep after one day: %+v %v", res, err)
	}
	// Past seven days every event created at t0 has expired and the cap tombstones are old enough to go.
	before, _ := e.svc.History(ctx, id, 1)
	e.clk.Advance(7 * 24 * time.Hour)
	if err := e.svc.RunSweep(ctx); err != nil {
		t.Fatal(err)
	}
	if c := e.count(`SELECT count(*) FROM clipboard_events`); c != 0 {
		t.Fatalf("%d rows survive the sweep", c)
	}
	// Even with every row gone, the next event continues the sequence (cursors never miss it), and history
	// still reports the highest seq.
	if h, _ := e.svc.History(ctx, id, 1); h.Cursor != before.Cursor || len(h.Events) != 0 {
		t.Fatalf("history after the sweep: %+v (cursor before %d)", h, before.Cursor)
	}
	next, err := e.svc.Create(ctx, id, input(newID(), 1))
	if err != nil || next.Seq != before.Cursor+1 {
		t.Fatalf("seq after sweep: %d (want %d) %v", next.Seq, before.Cursor+1, err)
	}
	// A tombstone younger than seven days survives a sweep; an older one goes.
	if err := e.svc.Clear(ctx, id); err != nil {
		t.Fatal(err)
	}
	e.clk.Advance(6 * 24 * time.Hour)
	if res, _ := e.svc.Sweep(ctx); res.Tombstones != 0 || e.count(`SELECT count(*) FROM clipboard_events WHERE deleted_at IS NOT NULL`) != 1 {
		t.Fatalf("a recent tombstone was swept: %+v", res)
	}
	e.clk.Advance(25 * time.Hour)
	if res, _ := e.svc.Sweep(ctx); res.Tombstones != 1 {
		t.Fatalf("an old tombstone was kept: %+v", res)
	}
}

func TestSettingsAndPause(t *testing.T) {
	e := newEnv(t, 100)
	_, tok := e.signup("fay@example.com")
	g := e.do("GET", "/v1/clipboard/settings", tok, nil)
	e.want(g, 200, "")
	if g.body["paused"] != false || g.body["retention_days"].(float64) != 7 || g.body["sensitive_skip"] != true {
		t.Fatalf("defaults: %s", g.raw)
	}
	if c := e.count(`SELECT count(*) FROM clipboard_settings`); c != 0 {
		t.Fatal("reading the settings must not create a row")
	}
	for _, bad := range []map[string]any{
		{"paused": true, "retention_days": 7},
		{"paused": true, "sensitive_skip": true},
		{"retention_days": 7, "sensitive_skip": true},
		{"paused": true, "retention_days": 0, "sensitive_skip": true},
		{"paused": true, "retention_days": 8, "sensitive_skip": true},
		{"paused": "yes", "retention_days": 7, "sensitive_skip": true},
		{"paused": true, "retention_days": 7, "sensitive_skip": true, "other": 1},
	} {
		e.want(e.do("PUT", "/v1/clipboard/settings", tok, bad), 400, "invalid_request")
	}
	id1 := newID()
	e.want(e.do("POST", "/v1/clipboard/events", tok, eventBody(id1, 1, 5)), 201, "")
	p := e.do("PUT", "/v1/clipboard/settings", tok, map[string]any{"paused": true, "retention_days": 3, "sensitive_skip": false})
	e.want(p, 200, "")
	if p.body["paused"] != true || p.body["retention_days"].(float64) != 3 || p.body["sensitive_skip"] != false {
		t.Fatalf("put: %s", p.raw)
	}
	if g := e.do("GET", "/v1/clipboard/settings", tok, nil); g.raw != p.raw {
		t.Fatalf("stored settings: %s vs %s", g.raw, p.raw)
	}
	// Paused: new events are refused and nothing is stored; reads and deletes still work, and a retry of an
	// event stored before the pause still returns its seq.
	idP := newID()
	e.want(e.do("POST", "/v1/clipboard/events", tok, eventBody(idP, 1, 5)), 409, "clipboard_paused")
	if c := e.count(`SELECT count(*) FROM clipboard_events WHERE event_id = $1::uuid`, idP); c != 0 {
		t.Fatal("an event was stored while paused")
	}
	if r := e.do("POST", "/v1/clipboard/events", tok, eventBody(id1, 1, 5)); r.code != 201 || r.body["seq"].(float64) != 1 {
		t.Fatalf("retry while paused: %s", r.raw)
	}
	e.want(e.do("GET", "/v1/clipboard/events", tok, nil), 200, "")
	e.want(e.do("GET", "/v1/clipboard/history", tok, nil), 200, "")
	e.want(e.do("DELETE", "/v1/clipboard/events/"+id1, tok, nil), 204, "")
	e.want(e.do("DELETE", "/v1/clipboard/history", tok, nil), 204, "")
	e.want(e.do("PUT", "/v1/clipboard/settings", tok, map[string]any{"paused": false, "retention_days": 3, "sensitive_skip": false}), 200, "")
	r := e.do("POST", "/v1/clipboard/events", tok, eventBody(idP, 1, 5))
	e.want(r, 201, "")
	if r.str("expires_at") != t0.Add(3*24*time.Hour).Format(time.RFC3339) {
		t.Fatalf("retention 3 days: %s", r.raw)
	}
}

// TestKeyVersionRule: a new event must use the account's current key version; nothing is stored otherwise,
// and a retry of an event stored before a rotation still returns its seq.
func TestKeyVersionRule(t *testing.T) {
	e := newEnv(t, 100)
	_, tok := e.signup("gus@example.com")
	id := e.ident(tok)
	// Before key setup (version 0) any version is ahead of the account.
	if _, err := e.pool.Exec(ctx, `UPDATE account_keys SET key_version = 0`); err != nil {
		t.Fatal(err)
	}
	e.want(e.do("POST", "/v1/clipboard/events", tok, eventBody(newID(), 1, 5)), 409, "key_version_conflict")
	if _, err := e.pool.Exec(ctx, `UPDATE account_keys SET key_version = 1`); err != nil {
		t.Fatal(err)
	}
	e.want(e.do("POST", "/v1/clipboard/events", tok, eventBody(newID(), 2, 5)), 409, "key_version_conflict")
	old := newID()
	e.want(e.do("POST", "/v1/clipboard/events", tok, eventBody(old, 1, 5)), 201, "")
	if _, err := e.pool.Exec(ctx, `UPDATE account_keys SET key_version = 2 WHERE user_id = $1::uuid`, id.AccountID); err != nil {
		t.Fatal(err)
	}
	stale := newID()
	e.want(e.do("POST", "/v1/clipboard/events", tok, eventBody(stale, 1, 5)), 409, "key_version_conflict")
	if c := e.count(`SELECT count(*) FROM clipboard_events WHERE event_id = $1::uuid`, stale); c != 0 {
		t.Fatal("an event under an old key version was stored")
	}
	if r := e.do("POST", "/v1/clipboard/events", tok, eventBody(old, 1, 5)); r.code != 201 || r.body["seq"].(float64) != 1 {
		t.Fatalf("retry of an event stored before the rotation: %s", r.raw)
	}
	if r := e.do("POST", "/v1/clipboard/events", tok, eventBody(stale, 2, 5)); r.code != 201 || r.body["seq"].(float64) != 2 {
		t.Fatalf("event under the current version: %s", r.raw)
	}
}

// TestDepartedDevicesCannotRead: a revoked or signed-out device loses clipboard access at once (its token no
// longer matches a live account session), its cursor row is deleted with its departure, and a not-added
// device of the same account is refused.
func TestDepartedDevicesCannotRead(t *testing.T) {
	e := newEnv(t, 100)
	_, tokA := e.signup("hal@example.com")
	b, tokB := e.signin("hal@example.com", true)
	c, tokC := e.signin("hal@example.com", true)
	_, tokN := e.signin("hal@example.com", false)
	e.want(e.do("POST", "/v1/clipboard/events", tokA, eventBody(newID(), 1, 5)), 201, "")
	e.want(e.do("GET", "/v1/clipboard/events?cursor=0", tokB, nil), 200, "")
	e.want(e.do("GET", "/v1/clipboard/events?cursor=1", tokC, nil), 200, "")
	if n := e.count(`SELECT count(*) FROM clipboard_device_cursors WHERE device_id = ANY($1::uuid[])`, []string{b.Device.ID, c.Device.ID}); n != 2 {
		t.Fatalf("%d cursors recorded", n)
	}
	for _, path := range []string{"/v1/clipboard/events", "/v1/clipboard/history", "/v1/clipboard/settings"} {
		e.want(e.do("GET", path, tokN, nil), 403, "device_not_added")
	}

	// A revokes B: B's existing token stops working for every clipboard route, and its cursor is gone.
	e.want(e.do("DELETE", "/v1/devices/"+b.Device.ID, tokA, nil), 204, "")
	e.want(e.do("POST", "/v1/clipboard/events", tokA, eventBody(newID(), 1, 5)), 201, "")
	for _, rq := range [][2]string{{"GET", "/v1/clipboard/events?cursor=1"}, {"GET", "/v1/clipboard/history"}, {"GET", "/v1/clipboard/settings"},
		{"DELETE", "/v1/clipboard/history"}} {
		e.want(e.do(rq[0], rq[1], tokB, nil), 401, "device_token_invalid")
	}
	e.want(e.do("POST", "/v1/clipboard/events", tokB, eventBody(newID(), 1, 5)), 401, "device_token_invalid")
	if n := e.count(`SELECT count(*) FROM clipboard_device_cursors WHERE device_id = $1::uuid`, b.Device.ID); n != 0 {
		t.Fatal("a revoked device's cursor survived its departure")
	}
	// The service refuses a stale identity even if a token check were skipped.
	if _, err := e.svc.Events(ctx, e.identUnchecked(tokB), 0, 10); err == nil {
		t.Fatal("a revoked device read events")
	}

	// C signs out: same.
	e.want(e.do("POST", "/v1/auth/signout", tokC, nil), 200, "")
	e.want(e.do("GET", "/v1/clipboard/events?cursor=1", tokC, nil), 401, "device_token_invalid")
	if n := e.count(`SELECT count(*) FROM clipboard_device_cursors WHERE device_id = $1::uuid`, c.Device.ID); n != 0 {
		t.Fatal("a signed-out device's cursor survived its departure")
	}
}

// TestNoPlaintextAtRest: the test encrypts a marker the way the client does (AES-256-GCM, AAD
// "<event_id>|<key_version>"), stores it, and checks that a dump of every clipboard table holds neither the
// marker nor its hex, while the ciphertext still decrypts after a round trip.
func TestNoPlaintextAtRest(t *testing.T) {
	e := newEnv(t, 100)
	_, tok := e.signup("ivy@example.com")
	marker := "SA-PLAINTEXT-MARKER-" + newID()
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	blk, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(blk)
	nonce := make([]byte, 12)
	_, _ = rand.Read(nonce)
	eventID := newID()
	aad := []byte(eventID + "|1")
	ct := gcm.Seal(nil, nonce, []byte(marker), aad)
	e.want(e.do("POST", "/v1/clipboard/events", tok, map[string]any{
		"event_id": eventID, "key_version": 1, "nonce": enc(nonce), "ciphertext": enc(ct), "payload_size": len(marker),
	}), 201, "")
	e.want(e.do("GET", "/v1/clipboard/events?cursor=0", tok, nil), 200, "")
	e.want(e.do("PUT", "/v1/clipboard/settings", tok, map[string]any{"paused": false, "retention_days": 7, "sensitive_skip": true}), 200, "")

	var dump strings.Builder
	for _, table := range []string{"clipboard_events", "clipboard_device_cursors", "clipboard_settings"} {
		rows, err := e.pool.Query(ctx, `SELECT t::text FROM `+table+` t`)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var s string
			if err := rows.Scan(&s); err != nil {
				t.Fatal(err)
			}
			dump.WriteString(s + "\n")
		}
		rows.Close()
	}
	d := strings.ToLower(dump.String())
	if !strings.Contains(d, eventID) {
		t.Fatal("the dump is missing the event (the check would pass vacuously)")
	}
	for _, needle := range []string{strings.ToLower(marker), hex.EncodeToString([]byte(marker)), hex.EncodeToString([]byte("SA-PLAINTEXT-MARKER"))} {
		if strings.Contains(d, needle) {
			t.Fatalf("plaintext marker found in the clipboard tables: %q", needle)
		}
	}
	// The stored bytes are what the client sent and still decrypt with the right AAD only.
	r := e.do("GET", "/v1/clipboard/events?cursor=0", tok, nil)
	ev := r.body["events"].([]any)[0].(map[string]any)
	gotCT, _ := b64(ev["ciphertext"].(string))
	gotNonce, _ := b64(ev["nonce"].(string))
	pt, err := gcm.Open(nil, gotNonce, gotCT, aad)
	if err != nil || string(pt) != marker {
		t.Fatalf("round trip: %v", err)
	}
	if _, err := gcm.Open(nil, gotNonce, gotCT, []byte(eventID+"|2")); err == nil {
		t.Fatal("a changed key_version in the AAD must fail")
	}
	if bytes.Contains(gotCT, []byte(marker)) {
		t.Fatal("ciphertext contains the plaintext")
	}
}

// TestRateLimits: event creation is limited to 60 per minute per device and 240 per minute per account
// (production values; ScaledLimits(clock, 1)).
func TestRateLimits(t *testing.T) {
	e := newEnv(t, 1)
	_, tok := e.signup("jo@example.com")
	toks := []string{tok}
	for i := 0; i < 4; i++ {
		_, tk := e.signin("jo@example.com", true)
		toks = append(toks, tk)
	}
	for i := 0; i < 60; i++ {
		if _, err := e.svc.Create(ctx, e.ident(toks[0]), input(newID(), 1)); err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
	}
	r := e.do("POST", "/v1/clipboard/events", toks[0], eventBody(newID(), 1, 5))
	e.want(r, 429, "rate_limited")
	if r.body["retry_after_s"] == nil {
		t.Fatalf("429 without retry_after_s: %s", r.raw)
	}
	// Other devices of the account keep going until the account has made 240 in the minute.
	for d := 1; d <= 3; d++ {
		for i := 0; i < 60; i++ {
			if _, err := e.svc.Create(ctx, e.ident(toks[d]), input(newID(), 1)); err != nil {
				t.Fatalf("device %d insert %d: %v", d, i, err)
			}
		}
	}
	e.want(e.do("POST", "/v1/clipboard/events", toks[4], eventBody(newID(), 1, 5)), 429, "rate_limited")
	e.clk.Advance(time.Minute)
	e.want(e.do("POST", "/v1/clipboard/events", toks[4], eventBody(newID(), 1, 5)), 201, "")
	e.want(e.do("POST", "/v1/clipboard/events", toks[0], eventBody(newID(), 1, 5)), 201, "")

	// Reads: GET /v1/clipboard/events and /v1/clipboard/history share 600 / min per device.
	for i := 0; i < 300; i++ {
		if _, err := e.svc.Events(ctx, e.ident(toks[1]), 0, 1); err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
		if _, err := e.svc.History(ctx, e.ident(toks[1]), 1); err != nil {
			t.Fatalf("history read %d: %v", i, err)
		}
	}
	for _, path := range []string{"/v1/clipboard/events?cursor=0", "/v1/clipboard/history"} {
		r := e.do("GET", path, toks[1], nil)
		e.want(r, 429, "rate_limited")
		if r.body["retry_after_s"] == nil {
			t.Fatalf("429 without retry_after_s: %s", r.raw)
		}
	}
	e.want(e.do("GET", "/v1/clipboard/events", toks[2], nil), 200, "") // per device
	e.clk.Advance(time.Minute)
	e.want(e.do("GET", "/v1/clipboard/history", toks[1], nil), 200, "")
}

// TestCursorWriteRacingDeparture (QA round 6 rule): a device reading events while it is revoked never leaves a
// cursor row behind. The read re-checks the session under the account key-row lock that every departure takes
// FOR UPDATE, so either the read commits first (and the departure deletes its cursor) or it sees the session
// ended and writes nothing.
func TestCursorWriteRacingDeparture(t *testing.T) {
	e := newEnv(t, 100)
	_, tokA := e.signup("max@example.com")
	e.want(e.do("POST", "/v1/clipboard/events", tokA, eventBody(newID(), 1, 5)), 201, "")
	for i := 0; i < 30; i++ {
		b, tokB := e.signin("max@example.com", true)
		idB := e.ident(tokB)
		var wg sync.WaitGroup
		var dr resp
		var readErr error
		wg.Add(2)
		go func() { defer wg.Done(); _, readErr = e.svc.Events(ctx, idB, 1, 10) }()
		go func() { defer wg.Done(); dr = e.do("DELETE", "/v1/devices/"+b.Device.ID, tokA, nil) }()
		wg.Wait()
		if dr.code != 204 {
			t.Fatalf("iteration %d: revoke %d", i, dr.code)
		}
		if n := e.count(`SELECT count(*) FROM clipboard_device_cursors WHERE device_id = $1::uuid`, b.Device.ID); n != 0 {
			t.Fatalf("iteration %d (read err %v): a cursor survived the departure", i, readErr)
		}
	}
}
