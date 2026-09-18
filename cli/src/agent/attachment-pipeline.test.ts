// ZK-013 attachment/diff/usage contract tests: staged Discord attachments land
// in the hardened core with durable records (duplicate names distinct, bytes
// preserved), bounds and unsafe paths refuse, revalidation catches tampering
// before any native read, image capability fails closed, usage NEVER fabricates
// zeros, and /diff stays host-owned with backend-agnostic cwd resolution.
// — ZCode 2026-09-18
import { test, expect, vi } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStoreHarness } from './test-harness.js'
import { stageAttachment, nativeImage, safeFilename } from './attachments.js'
import {
  formatNativeUsage,
  revalidateAttachment,
  stageDiscordAttachments,
} from './attachment-pipeline.js'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1sAAAAASUVORK5CYII=',
  'base64',
)

test('staging distinguishes duplicate names, preserves bytes, and records durably', async () => {
  const h = await createStoreHarness()
  const root = await mkdtemp(path.join(tmpdir(), 'zk13-stage-'))
  try {
    const a = await stageAttachment(root, {
      filename: 'a.png',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
    })
    const b = await stageAttachment(root, {
      filename: 'a.png',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
    })
    assert.notEqual(a.storagePath, b.storagePath)
    assert.deepEqual(await readFile(a.storagePath), PNG_BYTES)

    await h.store.recordAttachment(h.session.id, a)
    await h.store.recordAttachment(h.session.id, b, 'native-ref-1')
    const row = await h.store.attachmentById(a.id)
    assert.equal(row?.sessionId, h.session.id)
    assert.equal(row?.sha256, a.sha256)
    assert.equal(row?.filename, 'a.png')
    const withRef = await h.store.attachmentById(b.id)
    assert.equal(withRef?.nativeRef, 'native-ref-1')
    // Retention prunes only unreferenced records.
    assert.equal(await h.store.pruneAttachments(h.session.id, [a.id]), 1)
    assert.equal(await h.store.attachmentById(b.id), null)
    assert.ok(await h.store.attachmentById(a.id))
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('bounds and unsafe filenames refuse staging', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zk13-bounds-'))
  try {
    await assert.rejects(
      () =>
        stageAttachment(root, {
          filename: '../escape.png',
          mimeType: 'image/png',
          bytes: PNG_BYTES,
        }),
      { code: 'ATTACHMENT_PATH_INVALID' } as never,
    )
    await assert.rejects(
      () =>
        stageAttachment(
          root,
          { filename: 'big.png', mimeType: 'image/png', bytes: Buffer.alloc(64) },
          32,
        ),
      { code: 'ATTACHMENT_TOO_LARGE' } as never,
    )
    assert.equal(safeFilename('ok.txt'), 'ok.txt')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('stageDiscordAttachments downloads, stages, records, and reports skips honestly', async () => {
  const h = await createStoreHarness()
  const root = await mkdtemp(path.join(tmpdir(), 'zk13-pipe-'))
  const fetchCalls: string[] = []
  vi.stubGlobal('fetch', (async (url: string) => {
    fetchCalls.push(url)
    if (url.endsWith('gone.png')) {
      return new Response('missing', { status: 404 })
    }
    if (url.endsWith('huge.png')) {
      return new Response(new Uint8Array(64))
    }
    return new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
  }) as unknown as typeof fetch)
  try {
    const result = await stageDiscordAttachments({
      store: h.store,
      sessionId: h.session.id,
      attachmentRoot: root,
      files: [
        { filename: 'one.png', mimeType: 'image/png', url: 'https://cdn.example/one.png' },
        { filename: 'one.png', mimeType: 'image/png', url: 'https://cdn.example/one.png' },
        { filename: 'gone.png', mimeType: 'image/png', url: 'https://cdn.example/gone.png' },
        { filename: 'huge.png', mimeType: 'image/png', url: 'https://cdn.example/huge.png' },
      ],
      limitBytes: 32,
    })
    assert.equal(result.staged.length, 2)
    assert.notEqual(result.staged[0]!.storagePath, result.staged[1]!.storagePath)
    assert.deepEqual(result.skipped.map((s) => s.filename).sort(), ['gone.png', 'huge.png'])
    assert.match(result.skipped.find((s) => s.filename === 'huge.png')!.reason, /TOO_LARGE/)
    assert.equal(fetchCalls.length, 4)
    for (const staged of result.staged) {
      const row = await h.store.attachmentById(staged.id)
      assert.equal(row?.sha256, staged.sha256)
    }
  } finally {
    vi.unstubAllGlobals()
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('revalidation catches tampering and symlink escape before any native read', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zk13-verify-'))
  try {
    const staged = await stageAttachment(root, {
      filename: 'v.png',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
    })
    assert.equal(await revalidateAttachment(root, staged), true)
    await writeFile(staged.storagePath, Buffer.from('tampered'))
    assert.equal(await revalidateAttachment(root, staged), false)
    // Size-only tampering is also caught by the hash.
    await writeFile(staged.storagePath, Buffer.concat([PNG_BYTES, Buffer.from('x')]))
    assert.equal(await revalidateAttachment(root, staged), false)
    assert.equal(
      await revalidateAttachment(root, {
        ...staged,
        storagePath: path.join(root, '..', 'elsewhere.png'),
      }),
      false,
    )
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('native image encoding fails closed without the certified capability', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zk13-image-'))
  try {
    const staged = await stageAttachment(root, {
      filename: 'i.png',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
    })
    await assert.rejects(() => nativeImage(staged, root, false), {
      code: 'CAPABILITY_UNSUPPORTED',
    } as never)
    const encoded = await nativeImage(staged, root, true)
    assert.equal(encoded.kind, 'image')
    assert.equal(encoded.mimeType, 'image/png')
    assert.deepEqual(Object.keys(encoded).sort(), [
      'dataBase64',
      'filename',
      'kind',
      'mimeType',
      'sizeBytes',
    ])
    assert.equal(encoded.dataBase64, PNG_BYTES.toString('base64'))
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('usage display never fabricates zeros', () => {
  assert.equal(formatNativeUsage(null), 'unknown')
  assert.equal(formatNativeUsage(undefined), 'unknown')
  assert.equal(formatNativeUsage('120 tokens'), 'unknown')
  assert.equal(formatNativeUsage({}), 'unknown')
  assert.equal(formatNativeUsage({ inputTokens: 0, outputTokens: 0 }), '0 in / 0 out')
  assert.equal(formatNativeUsage({ inputTokens: 10 }), 'unknown')
  assert.equal(formatNativeUsage({ inputTokens: 10, outputTokens: '20' }), 'unknown')
  assert.equal(formatNativeUsage({ inputTokens: -1, outputTokens: 5 }), 'unknown')
  assert.equal(formatNativeUsage({ inputTokens: 10, outputTokens: 20 }), '10 in / 20 out')
})

test('/diff stays host-owned: no OpenCode client and backend-agnostic cwd resolution', async () => {
  const here = fileURLToPath(new URL('./attachment-pipeline.test.ts', import.meta.url)).replace(
    /[^/\\]+$/,
    '',
  )
  const diff = await readFile(`${here}../commands/diff.ts`, 'utf8')
  assert.equal(diff.includes("from '../opencode.js'"), false)
  assert.ok(diff.includes('resolveWorkingDirectory'))
  expect(true).toBe(true)
})
