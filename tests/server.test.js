import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createServer } from '../server/server.js';

let temporary, rootDir, dataDir, server, base, createdId;
const start = async options => {
  const instance = await createServer(options);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  return instance;
};
const close = instance => new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
const call = async (url, options = {}) => {
  const response = await fetch(base + url, options);
  const content = await response.text();
  let body;
  try { body = JSON.parse(content); } catch { body = content; }
  return { status: response.status, body, headers: response.headers };
};
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const raw = (pathname, headers = {}) => new Promise((resolve, reject) => {
  const url = new URL(base);
  const request = http.request({ hostname: url.hostname, port: url.port, path: pathname, headers }, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => body += chunk);
    response.on('end', () => resolve({ status: response.statusCode, body }));
  });
  request.on('error', reject);
  request.end();
});

before(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'istochnik-server-'));
  rootDir = path.join(temporary, 'site');
  dataDir = path.join(rootDir, '.local-data');
  await mkdir(path.join(rootDir, 'src'), { recursive: true });
  await mkdir(path.join(rootDir, 'server'));
  await writeFile(path.join(rootDir, 'index.html'), '<!doctype html><title>Локальный тест</title>');
  await writeFile(path.join(rootDir, 'src', 'app.js'), 'export const test = true;');
  await writeFile(path.join(rootDir, '.secret'), 'not-public');
  await writeFile(path.join(rootDir, 'server', 'private.js'), 'not-public');
  await writeFile(path.join(temporary, 'outside.txt'), 'not-public');
  await symlink(path.join(temporary, 'outside.txt'), path.join(rootDir, 'escape.txt'));
  await symlink(path.join(rootDir, 'server', 'private.js'), path.join(rootDir, 'src', 'linked-private.js'));
  await symlink(path.join(rootDir, '.secret'), path.join(rootDir, 'src', 'linked-secret.txt'));
  server = await start({ rootDir, dataDir });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await close(server); await rm(temporary, { recursive: true, force: true }); });

test('health confirms local server and does not require a paid service', async () => {
  const result = await call('/api/health');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, mode: 'local-server' });
});

test('serves application with security headers and no cache', async () => {
  const result = await call('/');
  assert.equal(result.status, 200);
  assert.match(result.body, /Локальный тест/);
  assert.match(result.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  const script = await call('/src/app.js');
  assert.match(script.headers.get('content-type'), /javascript/);
});

test('empty queue is a real empty queue', async () => {
  assert.deepEqual((await call('/api/tickets')).body, { tickets: [] });
});

test('creates ticket and preserves source snapshot as data', async () => {
  const result = await call('/api/tickets', post({
    question: 'Кто отвечает за тестовый стенд?', answer: 'В инструкциях нет ответа.', contact: 'Тестовый контакт',
    sources: [{ documentId: 'test', documentTitle: 'Тест', sectionId: 'section-1', heading: 'Доступ', quote: '  <script>inert</script>\n  точная цитата  ', startLine: 1, endLine: 3 }],
  }));
  assert.equal(result.status, 201);
  assert.equal(result.body.ticket.status, 'new');
  assert.equal(result.body.ticket.question, 'Кто отвечает за тестовый стенд?');
  assert.equal(result.body.ticket.sources[0].quote, '  <script>inert</script>\n  точная цитата  ');
  assert.match(result.body.ticket.id, /^[a-f0-9-]{36}$/);
  createdId = result.body.ticket.id;
  assert.equal((await call('/api/tickets')).body.tickets[0].id, createdId);
  const persisted = JSON.parse(await readFile(path.join(dataDir, 'tickets.json'), 'utf8'));
  assert.equal(persisted[0].id, createdId);
});

test('updates queue status and persists it', async () => {
  const result = await call(`/api/tickets/${createdId}`, { ...post({ status: 'in_progress' }), method: 'PATCH' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ticket.status, 'in_progress');
  const persisted = JSON.parse(await readFile(path.join(dataDir, 'tickets.json'), 'utf8'));
  assert.equal(persisted[0].status, 'in_progress');
});

test('queue is stored with owner-only permissions', async () => {
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dataDir, 'tickets.json'))).mode & 0o777, 0o600);
});

test('data survives server restart', async () => {
  await close(server);
  server = await start({ rootDir, dataDir });
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call('/api/tickets')).body.tickets[0].status, 'in_progress');
});

test('concurrent writes do not lose tickets', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => call('/api/tickets', post({ question: `Параллельный тест ${index}` }))));
  assert.ok(results.every(result => result.status === 201));
  const tickets = (await call('/api/tickets')).body.tickets;
  assert.equal(tickets.length, 9);
  assert.equal(new Set(tickets.map(ticket => ticket.id)).size, 9);
});

test('unknown IDs and invalid statuses cannot mutate queue', async () => {
  const missing = await call('/api/tickets/11111111-1111-1111-1111-111111111111', { ...post({ status: 'closed' }), method: 'PATCH' });
  assert.equal(missing.status, 404);
  const invalid = await call(`/api/tickets/${createdId}`, { ...post({ status: 'sent' }), method: 'PATCH' });
  assert.equal(invalid.status, 400);
  assert.equal((await call('/api/tickets')).body.tickets.find(ticket => ticket.id === createdId).status, 'in_progress');
});

test('rejects empty question, overlong contact, malformed sources and JSON', async () => {
  for (const payload of [{ question: '' }, { question: 'Тест', contact: 'x'.repeat(251) }, { question: 'Тест', sources: 'wrong' }, { question: 'Тест', sources: [{ startLine: -1 }] }]) {
    assert.equal((await call('/api/tickets', post(payload))).status, 400);
  }
  const malformed = await call('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await call('/api/tickets', { method: 'POST', body: 'hello' })).status, 415);
  assert.equal((await call('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/jsonp' }, body: '{}' })).status, 415);
  assert.equal((await call('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]) })).status, 400);
});

test('rejects oversized request before saving', async () => {
  const result = await call('/api/tickets', post({ question: 'x'.repeat(1_500_001) }));
  assert.equal(result.status, 413);
});

test('incomplete or malformed source snapshots cannot corrupt the queue', async () => {
  const source = { documentId: 'document', documentTitle: 'Инструкция', sectionId: 'section', heading: 'Раздел', quote: 'Точная цитата.', startLine: 3, endLine: 3 };
  const countBefore = (await call('/api/tickets')).body.tickets.length;
  const invalidSources = [{}];
  for (const key of Object.keys(source)) {
    const incomplete = { ...source };
    delete incomplete[key];
    invalidSources.push(incomplete);
    invalidSources.push({ ...source, [key]: null });
  }
  invalidSources.push({ ...source, quote: '  ' }, { ...source, startLine: '3' }, { ...source, endLine: 2 }, { ...source, startLine: 0 });
  for (const invalid of invalidSources) {
    assert.equal((await call('/api/tickets', post({ question: 'Тест снимка', sources: [invalid] }))).status, 400);
  }
  const saved = (await call('/api/tickets')).body.tickets;
  assert.equal(saved.length, countBefore);
  assert.ok(saved.every(ticket => ticket.sources.every(item => Object.keys(source).every(key => Object.hasOwn(item, key)))));
});

test('rejects cross-origin API reads and writes', async () => {
  assert.equal((await call('/api/tickets', { headers: { origin: 'https://example.test' } })).status, 403);
  const options = post({ question: 'Внешний сайт' });
  options.headers.origin = 'null';
  assert.equal((await call('/api/tickets', options)).status, 403);
  assert.equal((await call('/api/tickets', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call('/api/tickets', { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
});

test('accepts the same origin and rejects DNS-rebinding Host', async () => {
  assert.equal((await call('/api/health', { headers: { origin: base } })).status, 200);
  assert.equal((await raw('/api/tickets', { Host: `evil.example:${server.address().port}` })).status, 403);
  assert.equal((await raw('/api/tickets', { Host: '127.0.0.1:1' })).status, 403);
  assert.equal((await raw('/api/tickets', { Host: `localhost:${server.address().port}#forged` })).status, 403);
});

test('private storage, server code and dotfiles are never served', async () => {
  for (const url of ['/.local-data/tickets.json', '/server/private.js', '/.secret', '/package.json', '/src/linked-private.js', '/src/linked-secret.txt']) {
    assert.equal((await call(url)).status, 404);
  }
});

test('path traversal, escaped separators, malformed encoding and symlinks cannot escape', async () => {
  for (const url of ['/../outside.txt', '/%2e%2e/outside.txt', '/%2e%2e%2foutside.txt', '/..%5coutside.txt', '/%00']) {
    assert.equal((await raw(url)).status, 403, url);
  }
  assert.equal((await raw('/%GG')).status, 400);
  assert.equal((await call('/escape.txt')).status, 404);
});

test('unknown routes and unsupported methods return clear errors', async () => {
  assert.equal((await call('/api/missing')).status, 404);
  assert.equal((await call('/index.html', { method: 'PUT' })).status, 405);
});

test('answer API calls the shared engine and returns exact source', async () => {
  const result = await call('/api/answer', post({
    question: 'Как часто меняют пароль для тестового стенда?',
    documents: [{ id: 'uploaded', title: 'Тестовая инструкция', filename: 'test.md', text: '# Тестовая инструкция\n\n## Доступ к стенду\nПароль для тестового стенда меняют каждые 30 дней.' }],
  }));
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'answered');
  assert.ok(result.body.sources.length > 0);
  assert.ok(result.body.sources[0].quote.includes('каждые 30 дней'));
});

test('answer API validates uploads and cannot trust forged sections', async () => {
  const invalid = await call('/api/answer', post({ question: 'Тест?', documents: [{ id: 'same', text: 'Первый' }, { id: 'same', text: 'Второй' }] }));
  assert.equal(invalid.status, 400);
  const result = await call('/api/answer', post({ question: 'Какой код у принтера?', documents: [{ id: 'uploaded', text: 'Инструкция о парковке.', sections: [{ heading: 'Принтер', text: 'Код принтера — 9999.' }] }] }));
  assert.equal(result.status, 200);
  assert.notEqual(result.body.status, 'answered');
  const headingOnly = await call('/api/answer', post({ question: 'Доступ к стенду?', documents: [{ id: 'heading', text: '# Пустой раздел' }] }));
  assert.equal(headingOnly.status, 400);
  const overDocumentLimit = await call('/api/answer', post({ question: 'Тест?', documents: [{ id: 'large', text: 'x'.repeat(100_001) }] }));
  assert.equal(overDocumentLimit.status, 400);
});

test('corrupt queue is reported and never overwritten', async () => {
  const brokenDir = path.join(temporary, 'broken');
  await mkdir(brokenDir);
  const filename = path.join(brokenDir, 'tickets.json');
  await writeFile(filename, '{broken');
  await assert.rejects(createServer({ rootDir, dataDir: brokenDir }));
  assert.equal(await readFile(filename, 'utf8'), '{broken');
});

test('invalid stored ticket structure and duplicate IDs are rejected without rewriting', async () => {
  const badDir = path.join(temporary, 'invalid-records');
  await mkdir(badDir);
  const filename = path.join(badDir, 'tickets.json');
  const valid = { id: '11111111-1111-1111-1111-111111111111', question: 'Тест', answer: '', contact: '', sources: [], status: 'new', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  for (const state of [[{ ...valid, question: '' }], [valid, valid], [{ ...valid, sources: [{}] }], [{ ...valid, sources: [{ documentTitle: 'Неполный источник', heading: 'Раздел', quote: 'Текст', startLine: 1, endLine: 1 }] }]]) {
    const content = JSON.stringify(state);
    await writeFile(filename, content);
    await assert.rejects(createServer({ rootDir, dataDir: badDir }));
    assert.equal(await readFile(filename, 'utf8'), content);
  }
});
