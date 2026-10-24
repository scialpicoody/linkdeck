package framing

import (
	"bytes"
	"testing"
)

func TestSpecBuildsDelimiter(t *testing.T) {
	framer, err := New(Spec{Kind: "delimiter", DelimiterHex: "0A"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := framer.Feed([]byte("AT\r\nOK\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || string(got[0]) != "AT" || string(got[1]) != "OK" {
		t.Fatalf("frames=%q", got)
	}
}

func TestSpecBuildsFixedSize(t *testing.T) {
	framer, err := New(Spec{Kind: "fixed-size", FixedSize: 2})
	if err != nil {
		t.Fatal(err)
	}
	got, err := framer.Feed([]byte("abcd"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || !bytes.Equal(got[1], []byte("cd")) {
		t.Fatalf("frames=%q", got)
	}
}

func TestSpecBuildsLengthPrefix(t *testing.T) {
	framer, err := New(Spec{Kind: "length-prefix", LengthWidth: 1})
	if err != nil {
		t.Fatal(err)
	}
	got, err := framer.Feed([]byte{2, 'O', 'K'})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !bytes.Equal(got[0], []byte{2, 'O', 'K'}) {
		t.Fatalf("frames=%q", got)
	}
}

func TestSpecBuildsHeaderChecksum(t *testing.T) {
	framer, err := New(Spec{
		Kind:         "header-checksum",
		HeaderHex:    "AA55",
		LengthOffset: 2,
		LengthWidth:  1,
		Checksum:     "xor",
	})
	if err != nil {
		t.Fatal(err)
	}
	body := []byte{0xAA, 0x55, 0x01, 'X'}
	got, err := framer.Feed(append(body, ChecksumXOR.compute(body)))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !bytes.Equal(got[0][:4], body) {
		t.Fatalf("frames=%q", got)
	}
}

func TestSpecRejectsInvalidValues(t *testing.T) {
	cases := []Spec{
		{Kind: "delimiter", DelimiterHex: "zz"},
		{Kind: "fixed-size", FixedSize: 0},
		{Kind: "length-prefix", LengthWidth: 3},
		{Kind: "length-prefix", LengthWidth: 1, LengthEndian: "middle"},
		{Kind: "header-checksum", HeaderHex: "AA", LengthOffset: 1, LengthWidth: 1, Checksum: "bad"},
		{Kind: "unknown"},
	}
	for _, spec := range cases {
		if _, err := New(spec); err == nil {
			t.Fatalf("New(%+v) succeeded", spec)
		}
	}
}

func TestSpecLengthPrefixEndian(t *testing.T) {
	framer, err := New(Spec{
		Kind:         "length-prefix",
		LengthWidth:  2,
		LengthEndian: "little",
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := framer.Feed([]byte{2, 0, 'O', 'K'})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !bytes.Equal(got[0], []byte{2, 0, 'O', 'K'}) {
		t.Fatalf("frames=%q", got)
	}
}
