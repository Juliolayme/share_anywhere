package devices

import (
	"crypto/rand"
	"math/big"
	"strings"
	"unicode"
)

var adjectives = []string{
	"Calm", "Bright", "Swift", "Quiet", "Brave", "Clever", "Gentle", "Lucky", "Happy", "Bold",
	"Kind", "Merry", "Nimble", "Proud", "Sunny", "Witty", "Eager", "Fancy", "Jolly", "Keen",
	"Lively", "Mellow", "Noble", "Plucky", "Rapid", "Silver", "Tidy", "Vivid", "Warm", "Zesty",
	"Amber", "Cosmic",
}

var animals = []string{
	"Otter", "Falcon", "Panda", "Heron", "Fox", "Koala", "Lynx", "Robin", "Tiger", "Whale",
	"Badger", "Crane", "Dolphin", "Eagle", "Gecko", "Ibis", "Jaguar", "Lemur", "Marten", "Newt",
	"Osprey", "Puffin", "Quokka", "Raven", "Seal", "Toucan", "Walrus", "Yak", "Zebra", "Bison",
	"Wren", "Stork",
}

func pick(list []string) string {
	n, err := rand.Int(rand.Reader, big.NewInt(int64(len(list))))
	if err != nil {
		return list[0]
	}
	return list[n.Int64()]
}

// GenerateName returns "<platform> · <Adjective> <Animal>", trimmed to the 40-character limit.
func GenerateName(platform string) string {
	words := pick(adjectives) + " " + pick(animals)
	name := strings.TrimSpace(platform) + " · " + words
	if r := []rune(name); len(r) > 40 {
		return words
	}
	return name
}

// CleanText trims, collapses whitespace, and removes control and format characters.
func CleanText(s string) string {
	var b strings.Builder
	space := false
	for _, r := range strings.TrimSpace(s) {
		switch {
		case unicode.IsSpace(r):
			space = true
		case unicode.IsControl(r) || unicode.Is(unicode.Cf, r):
			// dropped: control and bidi/format characters
		default:
			if space && b.Len() > 0 {
				b.WriteByte(' ')
			}
			space = false
			b.WriteRune(r)
		}
	}
	return b.String()
}
