import http from 'node:http';
import { readFile, writeFile, mkdir, rename, realpath, stat, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY_BYTES = 1_500_000;
const MAX_TICKETS = 500;
const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'favicon.svg']);
const PUBLIC_DIRECTORIES = new Set(['src', 'data', 'assets']);
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/plain; charset=utf-8'], ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.ico', 'image/x-icon'], ['.woff2', 'font/woff2'],
]);

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function safeText(value, name, max, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new ApiError(400, `Некорректное поле «${name}» (до ${max} символов).`);
  }
  return value.trim();
}

function validateSources(sources) {
  if (!Array.isArray(sources) || sources.length > 10) throw new ApiError(400, 'Источники должны быть массивом: не более 10.');
  return sources.map(source => {
    if (!isRecord(source)) throw new ApiError(400, 'Некорректный источник.');
    const clean = {};
    for (const field of ['documentId', 'documentTitle', 'sectionId', 'heading', 'quote']) {
      const validated = safeText(source[field], field, field === 'quote' ? 15_000 : 300);
      // A source is a complete snapshot. Keep quote whitespace exactly as supplied.
      clean[field] = field === 'quote' ? source[field] : validated;
    }
    for (const field of ['startLine', 'endLine']) {
      if (!Number.isSafeInteger(source[field]) || source[field] < 1) throw new ApiError(400, 'Некорректный номер строки источника.');
      clean[field] = source[field];
    }
    if (clean.endLine < clean.startLine) throw new ApiError(400, 'Неверный диапазон строк.');
    return clean;
  });
}

function validateTicket(value) {
  if (!isRecord(value)) throw new ApiError(400, 'Ожидался объект JSON.');
  return {
    question: safeText(value.question, 'Вопрос', 2_000),
    answer: safeText(value.answer, 'Ответ', 30_000, { optional: true }),
    sources: validateSources(value.sources ?? []),
    contact: safeText(value.contact, 'Контакт', 250, { optional: true }),
  };
}

function validateDocuments(documents) {
  if (!Array.isArray(documents) || documents.length > 30) throw new ApiError(400, 'Нужно передать до 30 документов.');
  let total = 0;
  const ids = new Set();
  return documents.map((document, index) => {
    if (!isRecord(document)) throw new ApiError(400, 'Некорректный документ.');
    // Validate content and limits without shifting source lines or trimming quoted whitespace.
    safeText(document.text, 'Текст документа', 100_000);
    const text = document.text;
    total += text.length;
    if (total > 500_000) throw new ApiError(413, 'Суммарный объём документов превышает 500 000 символов.');
    const id = safeText(document.id ?? `document-${index + 1}`, 'ID документа', 100);
    if (ids.has(id)) throw new ApiError(400, 'ID документов должны быть уникальными.');
    ids.add(id);
    return {
      id, text,
      title: safeText(document.title ?? document.filename ?? `Документ ${index + 1}`, 'Название', 200),
      filename: safeText(document.filename ?? `document-${index + 1}.md`, 'Имя файла', 200),
      demo: document.demo === true,
    };
  });
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(String(request.headers['content-type'] ?? '').trim())) {
    throw new ApiError(415, 'Используйте Content-Type: application/json.');
  }
  const announced = Number(request.headers['content-length']);
  if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) throw new ApiError(413, 'Запрос слишком большой.');
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new ApiError(413, 'Запрос слишком большой.');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ApiError(400, 'Некорректный JSON.'); }
}

function checkLocalRequest(request) {
  const remote = request.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) throw new ApiError(403, 'Доступ разрешён только с этого компьютера.');
  const host = request.headers.host;
  let origin;
  try { origin = new URL(`http://${host}`); }
  catch { throw new ApiError(403, 'Недопустимый Host.'); }
  if (!host || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
      Number(origin.port || 80) !== request.socket.localPort) throw new ApiError(403, 'Недопустимый Host.');
  if (request.headers.origin && request.headers.origin !== origin.origin) throw new ApiError(403, 'Запрос с другого сайта отклонён.');
  if (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) throw new ApiError(403, 'Запрос с другого сайта отклонён.');
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

/** Local demonstration server. Does not bind a port until the caller calls listen(). */
export async function createServer({ dataDir = path.join(DEFAULT_ROOT, '.local-data'), rootDir = DEFAULT_ROOT } = {}) {
  const root = await realpath(rootDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const storage = await realpath(dataDir);
  if (storage === root) throw new Error('Папка очереди должна отличаться от корня сайта.');
  await chmod(storage, 0o700);
  const stateFile = path.join(storage, 'tickets.json');
  let tickets = [];
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (!Array.isArray(state) || state.length > MAX_TICKETS || state.some(ticket => !isRecord(ticket) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ticket.id) || !['new', 'in_progress', 'closed'].includes(ticket.status) || typeof ticket.createdAt !== 'string' || !Number.isFinite(Date.parse(ticket.createdAt)) || typeof ticket.updatedAt !== 'string' || !Number.isFinite(Date.parse(ticket.updatedAt)))) {
      throw new Error('Некорректное хранилище очереди. Исходный файл не изменён.');
    }
    const ids = new Set();
    tickets = state.map(ticket => {
      if (ids.has(ticket.id)) throw new Error('Повтор ID в хранилище очереди. Исходный файл не изменён.');
      ids.add(ticket.id);
      let fields;
      try { fields = validateTicket(ticket); }
      catch { throw new Error('Некорректные поля хранилища очереди. Исходный файл не изменён.'); }
      return { id: ticket.id, ...fields, status: ticket.status, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt };
    });
    await chmod(stateFile, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let transaction = Promise.resolve();
  const mutate = operation => {
    const pending = transaction.then(async () => {
      const next = structuredClone(tickets);
      const result = operation(next);
      const temporary = path.join(storage, `.tickets-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, stateFile);
      } finally {
        await rm(temporary, { force: true });
      }
      tickets = next;
      return result;
    });
    transaction = pending.catch(() => {});
    return pending;
  };

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      checkLocalRequest(request);
      let pathname;
      try { pathname = decodeURIComponent((request.url ?? '/').split('?')[0]); }
      catch { throw new ApiError(400, 'Некорректный адрес.'); }
      if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..')) throw new ApiError(403, 'Недопустимый путь.');
      const method = request.method;
      if (pathname === '/api/health' && method === 'GET') return json(response, 200, { ok: true, mode: 'local-server' });
      if (pathname === '/api/tickets' && method === 'GET') {
        await transaction;
        return json(response, 200, { tickets: [...tickets].reverse() });
      }
      if (pathname === '/api/tickets' && method === 'POST') {
        const fields = validateTicket(await readJson(request));
        const ticket = await mutate(next => {
          if (next.length >= MAX_TICKETS) throw new ApiError(409, 'Локальная очередь заполнена (500 вопросов).');
          const now = new Date().toISOString();
          const item = { id: randomUUID(), ...fields, status: 'new', createdAt: now, updatedAt: now };
          next.push(item);
          return item;
        });
        return json(response, 201, { ticket });
      }
      const ticketMatch = pathname.match(/^\/api\/tickets\/([a-f0-9-]{36})$/);
      if (ticketMatch && method === 'PATCH') {
        const body = await readJson(request);
        if (!isRecord(body) || !['new', 'in_progress', 'closed'].includes(body.status)) throw new ApiError(400, 'Неизвестный статус вопроса.');
        const ticket = await mutate(next => {
          const item = next.find(entry => entry.id === ticketMatch[1]);
          if (!item) throw new ApiError(404, 'Вопрос не найден.');
          item.status = body.status;
          item.updatedAt = new Date().toISOString();
          return item;
        });
        return json(response, 200, { ticket });
      }
      if (pathname === '/api/answer' && method === 'POST') {
        const body = await readJson(request);
        if (!isRecord(body)) throw new ApiError(400, 'Ожидался объект JSON.');
        const question = safeText(body.question, 'Вопрос', 2_000);
        const documents = validateDocuments(body.documents);
        const { answerQuestion, parseDocument } = await import('../src/engine.js');
        let parsed;
        try { parsed = documents.map(document => parseDocument(document)); }
        catch { throw new ApiError(400, 'Документ не содержит поддерживаемого текста разделов.'); }
        return json(response, 200, answerQuestion(question, parsed));
      }
      if (pathname.startsWith('/api/')) throw new ApiError(404, 'API-адрес не найден.');
      if (method !== 'GET' && method !== 'HEAD') throw new ApiError(405, 'Метод не поддерживается.');
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      const components = relative.split('/');
      const isPublicPath = relativePath => {
        const parts = relativePath.split(path.sep);
        return !parts.some(part => !part || part.startsWith('.')) &&
          (PUBLIC_FILES.has(relativePath) || (parts.length > 1 && PUBLIC_DIRECTORIES.has(parts[0])));
      };
      if (!isPublicPath(components.join(path.sep))) throw new ApiError(404, 'Файл не найден.');
      const candidate = path.resolve(root, relative);
      if (!isInside(candidate, root)) throw new ApiError(403, 'Недопустимый путь.');
      let resolved;
      try { resolved = await realpath(candidate); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new ApiError(404, 'Файл не найден.'); throw error; }
      if (!isInside(resolved, root) || isInside(resolved, storage) || !isPublicPath(path.relative(root, resolved))) throw new ApiError(404, 'Файл не найден.');
      const type = MIME.get(path.extname(resolved).toLowerCase());
      if (!type || !(await stat(resolved)).isFile()) throw new ApiError(404, 'Файл не найден.');
      const content = await readFile(resolved);
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.byteLength });
      response.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? 500, { error: error.status ? error.message : 'Локальная операция не выполнена. Проверьте права на папку данных.' });
      else response.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4316);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть целым числом от 1 до 65535.');
  const server = await createServer({ dataDir: process.env.DATA_DIR || path.join(DEFAULT_ROOT, '.local-data') });
  server.listen(port, '127.0.0.1', () => console.log(`ИСТОЧНИК: http://127.0.0.1:${port}/ — локальная очередь, без внешних отправок.`));
  server.on('error', error => { console.error(`Сервер не запущен: ${error.code || 'ошибка'}.`); process.exitCode = 1; });
}
