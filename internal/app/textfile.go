package app

import (
	"bytes"
	"strings"
	"unicode/utf16"
)

// Encoding is a text encoding Hashpad can read and write. SPEC §6.4 limits the
// set to these three deliberately; anything else round-trips as UTF-8 bytes.
type Encoding string

const (
	EncodingUTF8    Encoding = "utf-8"
	EncodingUTF8BOM Encoding = "utf-8-bom"
	// EncodingUTF16LE means UTF-16LE *with* a BOM — the Windows/Notepad
	// convention. BOM-less UTF-16LE is deliberately never detected: the
	// encoding model above has only these three values, so there is nowhere
	// to record "UTF-16LE but no BOM". Detecting it on open would force
	// Encode to invent a BOM on save, silently altering a file that was
	// never edited. If you're tempted to reinstate a sniffing heuristic
	// here, don't — see the round-trip test that guards this.
	EncodingUTF16LE Encoding = "utf-16le"
)

// LineEnding is the convention a file uses. Detected on open, restored on save,
// never silently converted (SPEC §6.4).
type LineEnding string

const (
	LineEndingLF   LineEnding = "lf"
	LineEndingCRLF LineEnding = "crlf"
)

var (
	bomUTF8    = []byte{0xEF, 0xBB, 0xBF}
	bomUTF16LE = []byte{0xFF, 0xFE}
)

// PLATFORM: when a file has no line ending to detect, we have to pick one.
// CRLF matches the untitled-document default so a one-line file doesn't change
// flavour the moment a second line is added. A Linux build should prefer LF.
const defaultLineEnding = LineEndingCRLF

// Decode converts raw file bytes into the LF-normalised UTF-8 string the editor
// holds, and reports what it found so Encode can put it back.
//
// The buffer is always LF because mixing CRLF into a CodeMirror document makes
// column counts and every formatting command's offset arithmetic wrong.
func Decode(raw []byte) (string, Encoding, LineEnding, bool) {
	enc, body := detectEncoding(raw)

	var text string
	if enc == EncodingUTF16LE {
		text = decodeUTF16LE(body)
	} else {
		text = string(body)
	}

	ending, mixed := detectLineEnding(text)
	return strings.ReplaceAll(text, "\r\n", "\n"), enc, ending, mixed
}

// Encode is the exact inverse of Decode: same encoding, same line ending, so an
// untouched file saves back byte-identical.
func Encode(text string, enc Encoding, ending LineEnding) []byte {
	if ending == LineEndingCRLF {
		text = strings.ReplaceAll(text, "\n", "\r\n")
	}

	switch enc {
	case EncodingUTF8BOM:
		return append(append([]byte{}, bomUTF8...), []byte(text)...)
	case EncodingUTF16LE:
		return encodeUTF16LE(text)
	default:
		return []byte(text)
	}
}

// detectEncoding returns the encoding and the body with any BOM removed.
func detectEncoding(raw []byte) (Encoding, []byte) {
	switch {
	case bytes.HasPrefix(raw, bomUTF8):
		return EncodingUTF8BOM, raw[len(bomUTF8):]
	case bytes.HasPrefix(raw, bomUTF16LE):
		return EncodingUTF16LE, raw[len(bomUTF16LE):]
	default:
		// Invalid UTF-8 lands here too, and that is deliberate: Go strings carry
		// invalid bytes intact, so the round trip stays lossless. Guessing at
		// Windows-1252 would corrupt files we cannot actually identify.
		return EncodingUTF8, raw
	}
}

func decodeUTF16LE(body []byte) string {
	units := make([]uint16, 0, len(body)/2)
	for i := 0; i+1 < len(body); i += 2 {
		units = append(units, uint16(body[i])|uint16(body[i+1])<<8)
	}
	return string(utf16.Decode(units))
}

func encodeUTF16LE(text string) []byte {
	units := utf16.Encode([]rune(text))
	out := make([]byte, 0, len(bomUTF16LE)+len(units)*2)
	out = append(out, bomUTF16LE...)
	for _, u := range units {
		out = append(out, byte(u), byte(u>>8))
	}
	return out
}

// detectLineEnding reports the first ending found and whether the file mixes
// both. SPEC §6.4 does not cover mixed files; we preserve the first convention
// and surface "mixed" so the flattening is visible rather than silent.
func detectLineEnding(text string) (LineEnding, bool) {
	firstCRLF := strings.Index(text, "\r\n")
	lfOnly := indexLoneLF(text)

	switch {
	case firstCRLF < 0 && lfOnly < 0:
		return defaultLineEnding, false
	case firstCRLF < 0:
		return LineEndingLF, false
	case lfOnly < 0:
		return LineEndingCRLF, false
	case firstCRLF < lfOnly:
		return LineEndingCRLF, true
	default:
		return LineEndingLF, true
	}
}

// indexLoneLF finds the first LF that is not part of a CRLF pair, so a pure
// CRLF file is not misreported as mixed.
func indexLoneLF(text string) int {
	for i := 0; i < len(text); i++ {
		if text[i] != '\n' {
			continue
		}
		if i == 0 || text[i-1] != '\r' {
			return i
		}
	}
	return -1
}
