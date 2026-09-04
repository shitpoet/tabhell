// Native messaging caps a single host -> Chrome message at 1 MB. Chunks travel
// inside a JSON envelope, so quotes and control chars re-escape and can inflate
// a chunk well past its raw size — hence the encoded-size check below.

const CHUNK_BYTES = 256 * 1024
const MAX_ENCODED_BYTES = 900 * 1024
const ENVELOPE_OVERHEAD = 128

const encoder = new TextEncoder()
const decoder = new TextDecoder()

let counter = 0

// Back `end` up until it sits on a UTF-8 code point boundary, so every chunk
// decodes to a valid string on its own.
function charBoundary(bytes, start, end) {
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
    end--
  }
  return end
}

function encodedSize(text) {
  return encoder.encode(JSON.stringify(text)).length + ENVELOPE_OVERHEAD
}

export function fragment(msg) {
  const bytes = encoder.encode(JSON.stringify(msg))
  const id = 'f' + (++counter)
  const parts = []
  let start = 0

  while (start < bytes.length) {
    let size = CHUNK_BYTES
    let end = charBoundary(bytes, start, Math.min(start + size, bytes.length))
    let text = decoder.decode(bytes.subarray(start, end))
    while (encodedSize(text) > MAX_ENCODED_BYTES && end - start > 1) {
      size = Math.floor((end - start) / 2)
      end = charBoundary(bytes, start, start + size)
      text = decoder.decode(bytes.subarray(start, end))
    }
    parts.push(text)
    start = end
  }

  if (parts.length === 0) {
    parts.push('')
  }
  return parts.map((text, i) => ({ f: id, i, n: parts.length, s: text }))
}

// Returns the reassembled message, or null while fragments are still missing.
export function makeAssembler() {
  const pending = {}

  return function assemble(envelope) {
    if (envelope.n === 1) {
      return JSON.parse(envelope.s)
    }
    if (pending[envelope.f] === undefined) {
      pending[envelope.f] = { parts: new Array(envelope.n), left: envelope.n }
    }
    const slot = pending[envelope.f]
    if (slot.parts[envelope.i] === undefined) {
      slot.parts[envelope.i] = envelope.s
      slot.left--
    }
    if (slot.left === 0) {
      delete pending[envelope.f]
      return JSON.parse(slot.parts.join(''))
    }
    return null
  }
}
