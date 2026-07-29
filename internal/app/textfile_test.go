package app

import (
	"bytes"
	"testing"
)

func TestDecode(t *testing.T) {
	tests := []struct {
		name       string
		raw        []byte
		wantText   string
		wantEnc    Encoding
		wantEnding LineEnding
		wantMixed  bool
	}{
		{
			name: "empty file defaults to utf-8 and crlf",
			raw:  []byte{}, wantText: "", wantEnc: EncodingUTF8, wantEnding: LineEndingCRLF,
		},
		{
			name:     "plain utf-8 with lf",
			raw:      []byte("# Title\nbody\n"),
			wantText: "# Title\nbody\n", wantEnc: EncodingUTF8, wantEnding: LineEndingLF,
		},
		{
			name:     "plain utf-8 with crlf normalises to lf",
			raw:      []byte("# Title\r\nbody\r\n"),
			wantText: "# Title\nbody\n", wantEnc: EncodingUTF8, wantEnding: LineEndingCRLF,
		},
		{
			name:     "utf-8 bom is stripped from the text",
			raw:      append([]byte{0xEF, 0xBB, 0xBF}, []byte("hello\n")...),
			wantText: "hello\n", wantEnc: EncodingUTF8BOM, wantEnding: LineEndingLF,
		},
		{
			name:     "bom-only file has no content",
			raw:      []byte{0xEF, 0xBB, 0xBF},
			wantText: "", wantEnc: EncodingUTF8BOM, wantEnding: LineEndingCRLF,
		},
		{
			name:     "utf-16le with bom",
			raw:      []byte{0xFF, 0xFE, 'h', 0x00, 'i', 0x00, '\n', 0x00},
			wantText: "hi\n", wantEnc: EncodingUTF16LE, wantEnding: LineEndingLF,
		},
		{
			name:     "utf-16le bom only",
			raw:      []byte{0xFF, 0xFE},
			wantText: "", wantEnc: EncodingUTF16LE, wantEnding: LineEndingCRLF,
		},
		{
			name:     "utf-16le crlf normalises to lf",
			raw:      []byte{0xFF, 0xFE, 'a', 0x00, '\r', 0x00, '\n', 0x00},
			wantText: "a\n", wantEnc: EncodingUTF16LE, wantEnding: LineEndingCRLF,
		},
		{
			name:     "bom-less utf-16le is not detected and round-trips as raw bytes",
			raw:      []byte{'h', 0x00, 'e', 0x00, 'l', 0x00, 'l', 0x00, 'o', 0x00},
			wantText: string([]byte{'h', 0x00, 'e', 0x00, 'l', 0x00, 'l', 0x00, 'o', 0x00}), wantEnc: EncodingUTF8, wantEnding: LineEndingCRLF,
		},
		{
			name:     "mixed endings report the first and set mixed",
			raw:      []byte("a\r\nb\nc\r\n"),
			wantText: "a\nb\nc\n", wantEnc: EncodingUTF8, wantEnding: LineEndingCRLF, wantMixed: true,
		},
		{
			name:     "mixed endings starting with lf",
			raw:      []byte("a\nb\r\n"),
			wantText: "a\nb\n", wantEnc: EncodingUTF8, wantEnding: LineEndingLF, wantMixed: true,
		},
		{
			name:     "single line with no ending defaults to crlf",
			raw:      []byte("no newline here"),
			wantText: "no newline here", wantEnc: EncodingUTF8, wantEnding: LineEndingCRLF,
		},
		{
			name:     "lone cr is left in the text and does not count as an ending",
			raw:      []byte("a\rb\n"),
			wantText: "a\rb\n", wantEnc: EncodingUTF8, wantEnding: LineEndingLF,
		},
		{
			name:     "invalid utf-8 is preserved byte for byte",
			raw:      []byte{'a', 0xFF, 0xFE, 'b'},
			wantText: string([]byte{'a', 0xFF, 0xFE, 'b'}), wantEnc: EncodingUTF8, wantEnding: LineEndingCRLF,
		},
		{
			name:     "utf-8 multibyte survives",
			raw:      []byte("héllo — ünïcode\n"),
			wantText: "héllo — ünïcode\n", wantEnc: EncodingUTF8, wantEnding: LineEndingLF,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			text, enc, ending, mixed := Decode(tt.raw)
			if text != tt.wantText {
				t.Errorf("text = %q, want %q", text, tt.wantText)
			}
			if enc != tt.wantEnc {
				t.Errorf("encoding = %q, want %q", enc, tt.wantEnc)
			}
			if ending != tt.wantEnding {
				t.Errorf("lineEnding = %q, want %q", ending, tt.wantEnding)
			}
			if mixed != tt.wantMixed {
				t.Errorf("mixed = %v, want %v", mixed, tt.wantMixed)
			}
		})
	}
}

// The property that matters most: a file that is opened and saved without edits
// must come back byte-identical, or "preserve on save" (SPEC §6.4) is a lie.
func TestDecodeEncodeRoundTrip(t *testing.T) {
	inputs := [][]byte{
		[]byte("plain\nlf\n"),
		[]byte("windows\r\nendings\r\n"),
		append([]byte{0xEF, 0xBB, 0xBF}, []byte("bom\r\ntext\r\n")...),
		{0xFF, 0xFE, 'h', 0x00, 'i', 0x00, '\r', 0x00, '\n', 0x00},
		[]byte("no trailing newline"),
		[]byte("héllo — ünïcode\n"),
		{},
		{'h', 0x00, 'e', 0x00, 'l', 0x00, 'l', 0x00, 'o', 0x00},
		{0xFF, 0xFE, 'a', 0x00, '\n', 0x00},
		append([]byte{0xEF, 0xBB, 0xBF}, []byte("a\nb\n")...),
	}

	for _, raw := range inputs {
		t.Run(string(raw), func(t *testing.T) {
			text, enc, ending, _ := Decode(raw)
			got := Encode(text, enc, ending)
			if !bytes.Equal(got, raw) {
				t.Errorf("round trip changed bytes:\n got %v\nwant %v", got, raw)
			}
		})
	}
}
