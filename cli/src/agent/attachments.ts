// ZK-007 port of the hardened standalone slice attachments.ts (staging +
// native image encoding with symlink/ownership/size guardrails). Full attachment
// ingress UX is ZK-013. — ZCode 2026-09-17
import { mkdir, open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { fail } from './errors.js'
export type Attachment = {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  sha256: string
  storagePath: string
}
export function safeFilename(name: string) {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[\\/\x00-\x1f<>:"|?*]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
  ) {
    throw fail('ATTACHMENT_PATH_INVALID', 'Unsafe attachment filename.')
  }
  // Bound UTF-8 bytes, not UTF-16 units; revalidate the resulting basename.
  let shortened = ''
  for (const character of name) {
    if (Buffer.byteLength(shortened + character) > 180) break
    shortened += character
  }
  if (/[. ]$/.test(shortened))
    throw fail('ATTACHMENT_PATH_INVALID', 'Truncation would produce an unsafe attachment filename.')
  return shortened
}
export async function stageAttachment(
  root: string,
  input: {
    filename: string
    mimeType: string
    bytes: Uint8Array
  },
  limit = 5 * 1024 * 1024,
): Promise<Attachment> {
  const filename = safeFilename(input.filename)
  if (input.bytes.length > limit) {
    throw fail('ATTACHMENT_TOO_LARGE', 'Attachment exceeds the byte limit.')
  }
  const bytes = Buffer.from(input.bytes) // immutable bounded copy before asynchronous I/O
  await mkdir(root, { recursive: true, mode: 0o700 })
  const canonical = await realpath(root)
  const directory = await stat(canonical)
  // POSIX permission/ownership hygiene. Windows stat() reports fake mode bits
  // (mkdtemp under %TEMP% carries no POSIX permissions), so the mode/uid check
  // is advisory there and the structural guards (O_EXCL/O_NOFOLLOW, realpath
  // containment below) carry the safety. — ZK-013 adaptation note
  const posix = process.platform !== 'win32'
  if (
    !directory.isDirectory() ||
    (posix && (directory.mode & 0o022) !== 0) ||
    (posix && process.getuid && directory.uid !== process.getuid())
  )
    throw fail(
      'ATTACHMENT_STORE_UNSAFE',
      'Attachment storage must be owned by this user and not writable by others.',
    )
  const id = randomUUID()
  const dir = path.join(canonical, id)
  await mkdir(dir, { mode: 0o700 })
  const storagePath = path.join(dir, filename)
  const file = await open(
    storagePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  return {
    id,
    filename,
    mimeType: input.mimeType,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    storagePath,
  }
}
export async function nativeImage(
  attachment: Attachment,
  storageRoot: string,
  imageCapability: boolean,
) {
  if (!imageCapability) {
    throw fail('CAPABILITY_UNSUPPORTED', 'Native image capability is not certified.')
  }
  const root = await realpath(storageRoot)
  const actual = await realpath(attachment.storagePath)
  const rel = path.relative(root, actual)
  if (!rel || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw fail('ATTACHMENT_PATH_INVALID', 'Attachment is outside approved storage.')
  }
  const filename = safeFilename(attachment.filename)
  const expectedSize = attachment.sizeBytes
  const handle = await open(attachment.storagePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const stat = await handle.stat()
    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      !stat.isFile() ||
      stat.size !== expectedSize ||
      stat.size > 5 * 1024 * 1024
    ) {
      throw fail('ATTACHMENT_CHANGED', 'Attachment size changed.')
    }
    // A file can grow after stat; never use an unbounded readFile here.
    const bounded = Buffer.alloc(expectedSize + 1)
    let used = 0
    while (used < bounded.length) {
      const read = await handle.read(bounded, used, bounded.length - used, used)
      if (read.bytesRead === 0) break
      used += read.bytesRead
    }
    if (used !== expectedSize)
      throw fail('ATTACHMENT_CHANGED', 'Attachment size changed while reading.')
    bytes = bounded.subarray(0, used)
  } finally {
    await handle.close()
  }
  if (createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) {
    throw fail('ATTACHMENT_CHANGED', 'Attachment contents changed.')
  }
  const signature =
    attachment.mimeType === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : attachment.mimeType === 'image/jpeg'
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : attachment.mimeType === 'image/gif'
          ? /^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))
          : attachment.mimeType === 'image/webp'
            ? bytes.subarray(0, 4).toString() === 'RIFF' &&
              bytes.subarray(8, 12).toString() === 'WEBP'
            : false
  if (!signature) {
    throw fail(
      'ATTACHMENT_UNSUPPORTED',
      'Unsupported image or MIME signature mismatch; documents are not relabelled as images.',
    )
  }
  return {
    kind: 'image',
    filename,
    mimeType: attachment.mimeType,
    sizeBytes: bytes.length,
    dataBase64: bytes.toString('base64'),
  }
}
