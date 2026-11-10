package sharing

import (
	"strings"
	"testing"
)

func TestWordlistAndSecurityWords(t *testing.T) {
	if len(Words) != 2048 || Words[0] != "abandon" || Words[2047] != "zoo" {
		t.Fatalf("word list: %d %q %q", len(Words), Words[0], Words[len(Words)-1])
	}
	k := deriveKeys([]byte("0123456789abcdef0123456789abcdef"))
	a := k.securityWords("s1", "d1")
	if len(a) != 3 || strings.Join(a, " ") != strings.Join(k.securityWords("s1", "d1"), " ") {
		t.Fatal("words must be deterministic per session and device")
	}
	if strings.Join(a, " ") == strings.Join(k.securityWords("s1", "d2"), " ") {
		t.Fatal("another device must get different words")
	}
	if strings.Join(a, " ") == strings.Join(deriveKeys([]byte("other-secret-other-secret-xxxxxx")).securityWords("s1", "d1"), " ") {
		t.Fatal("words are keyed by the server secret")
	}
}

func TestCodesTokensAndSealing(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		c := newCode()
		if !ValidCode(c) {
			t.Fatalf("bad code %q", c)
		}
		seen[c] = true
	}
	if len(seen) < 190 {
		t.Fatal("codes are not random enough")
	}
	for _, bad := range []string{"", "12345", "1234567", "12345a", "١٢٣٤٥٦"} {
		if ValidCode(bad) {
			t.Fatalf("%q accepted", bad)
		}
	}
	tok, h := newToken()
	if len(tok) != 32 || !ValidToken(tok) || string(hashToken(tok)) != string(h) {
		t.Fatalf("token %q", tok)
	}
	if ValidToken("short") || ValidToken(strings.Repeat("a", 129)) || ValidToken("bad*chars-0123456789abcdef") {
		t.Fatal("token shape checks")
	}
	k := deriveKeys([]byte("0123456789abcdef0123456789abcdef"))
	sealed := k.seal("482913")
	if got, err := k.open(sealed); err != nil || got != "482913" {
		t.Fatalf("open: %q %v", got, err)
	}
	sealed[len(sealed)-1] ^= 1
	if _, err := k.open(sealed); err == nil {
		t.Fatal("tampered value must fail")
	}
	if string(k.codeHMAC("000001")) == string(k.codeHMAC("000002")) {
		t.Fatal("hmac collision")
	}
}
