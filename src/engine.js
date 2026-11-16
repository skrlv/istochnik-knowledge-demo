/** Deterministic extractive retrieval. No network, model, evaluation or HTML rendering. */
const MAX_QUESTION = 1200;
const MAX_DOCUMENT = 500_000;
const MAX_SECTIONS = 500;
const MAX_EXTRACT = 12_000;
const STOP = new Set(('а и или но не ни это этот эта эти то как какой какая какие какое какого сколько когда где куда откуда почему зачем кто кому чем чего что если для на в во из с со у до по за при через о об от к ко без после перед ли же бы мне меня мой нам нас ваш пожалуйста подскажи подскажите расскажи скажи узнать можно нужно надо будет есть быть делать сделать получить получения хочу').split(' '));
const ALIASES = {
  доступы:'доступ', доступом:'доступ', доступа:'доступ', доступу:'доступ',
  crm:'crm', срм:'crm', црм:'crm',
  отпуска:'отпуск', отпуске:'отпуск', отпуском:'отпуск', отпуску:'отпуск',
  оформить:'оформление', оформлять:'оформление', оформляется:'оформление', оформитьcя:'оформление', оформлению:'оформление',
  вернуть:'возврат', возвращать:'возврат', возвращается:'возврат', возвращения:'возврат', возврата:'возврат', возврате:'возврат',
  оборудование:'оборудован', оборудования:'оборудован', оборудованием:'оборудован', технику:'оборудован', техники:'оборудован', техника:'оборудован',
  ноутбук:'ноутбук', ноутбука:'ноутбук', ноутбуком:'ноутбук', ноутбуке:'ноутбук',
  пароль:'пароль', пароля:'пароль', паролем:'пароль', паролей:'пароль',
  сбросить:'сброс', сброса:'сброс', восстановить:'сброс', восстановление:'сброс', забыл:'сброс', забыли:'сброс', забытый:'сброс',
  подать:'подача', подавать:'подача', подайте:'подача', подачи:'подача', подача:'подача',
  заявка:'заявка', заявку:'заявка', заявки:'заявка', заявкой:'заявка',
  срок:'срок', сроки:'срок', сроков:'срок', сроках:'срок',
  дней:'день', дня:'день', дни:'день', дню:'день', днях:'день',
  часов:'час', часа:'час', часы:'час', часу:'час',
  инцидент:'инцидент', инцидента:'инцидент', инциденте:'инцидент', инциденты:'инцидент',
  уведомить:'сообщить', сообщать:'сообщить', сообщение:'сообщить', сообщения:'сообщить',
  согласует:'согласование', согласовать:'согласование', согласования:'согласование', согласовывать:'согласование', согласовывает:'согласование',
  получить:'получение', получать:'получение', предоставление:'получение',
  сломалось:'поломка', сломался:'поломка', сломан:'поломка', поломки:'поломка',
  часто:'каждые', менять:'смена', меняют:'смена', меняется:'смена', сменить:'смена',
  утеря:'потеря', утере:'потеря', потерял:'потеря', потеряли:'потеря', потере:'потеря', потерю:'потеря',
  сотруднику:'сотрудник', сотрудника:'сотрудник', сотрудники:'сотрудник',
  удаленно:'удален', удаленный:'удален', удаленного:'удален', удаленном:'удален',
};
const INJECTION = /(?:игнориру[йя]|забуд[ьт]|отмени|переопредел[иы]).{0,80}(?:инструкци|правил)|(?:system|assistant|developer)\s*[:>]|раскро[йи].{0,30}(?:секрет|токен|парол)|выполни\s+(?:код|команд)|ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions|(?:you are now|теперь ты|отныне ты)\s+/iu;

function tokens(text) {
  return [...String(text).toLowerCase().replaceAll('ё','е').matchAll(/[\p{L}\p{N}]+/gu)]
    .map(m => m[0]).filter(w => (w.length > 1 || /^\d+$/u.test(w)) && !STOP.has(w))
    .map(w => stem(ALIASES[w] || w)).filter(Boolean);
}
function stem(word) {
  if (/^[a-z0-9]+$/.test(word) || word.length < 5) return word;
  return word.replace(/(?:иями|ями|ами|иями|ого|ему|ому|ыми|ими|ией|иям|иях|ение|ения|ению|ении|ений|аться|яться|овать|ировать|ить|ать|ять|ете|ите|ют|ут|ет|ит|ость|ости|овая|овый|овые|овой|ого|ему|ому|ым|им|ом|ем|ах|ях|ий|ый|ая|ое|ые|ой|ей|ию|ия|ие|ии|ов|ев|ы|и|а|я|у|ю|е|о)$/u,'');
}
function idSlug(s) {
  return String(s).toLowerCase().replaceAll('ё','е').replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'').slice(0,70) || 'section';
}
function safeInput(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name}: ожидается строка`);
  return value;
}

/** Parse Markdown headings; plain text is one section. Lines are one-based, inclusive. */
export function parseDocument({id, title, filename, text, demo = false} = {}) {
  safeInput(text,'Текст документа');
  if (!text.trim()) throw new Error('Документ пуст');
  if (text.length > MAX_DOCUMENT) throw new Error('Документ превышает 500 000 символов');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(text)) throw new Error('Поддерживаются только текстовые документы UTF-8 без повреждённых символов');
  const source = text.replace(/\r\n?/g,'\n');
  const docId = safeInput(id,'Идентификатор').trim();
  if (!docId) throw new Error('Не указан идентификатор документа');
  const docTitle = typeof title === 'string' && title.trim() ? title.trim().slice(0,200) : (filename || 'Инструкция');
  const lines = source.split('\n');
  const sections = [];
  let heading = docTitle;
  let start = 0;
  const add = end => {
    let first = start, last = end;
    while (first <= last && !lines[first]?.trim()) first++;
    while (last >= first && !lines[last]?.trim()) last--;
    if (last < first) return;
    const body = lines.slice(first,last + 1).join('\n');
    if (!body.trim()) return;
    sections.push({id: `${idSlug(heading)}-${sections.length + 1}`,heading,text:body,startLine:first + 1,endLine:last + 1});
  };
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = {char:marker[1][0],length:marker[1].length};
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    const match = !fence && lines[i].match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) {
      add(i - 1);
      heading = match[1].slice(0,200);
      start = i + 1;
    }
  }
  add(lines.length - 1);
  if (sections.length > MAX_SECTIONS) throw new Error('Слишком много разделов: максимум 500');
  if (!sections.length) throw new Error('В документе нет текста разделов');
  return {id:docId,title:docTitle,filename:typeof filename === 'string' ? filename.slice(0,200) : 'instruction.txt',text:source,demo:Boolean(demo),sections};
}

function result(status, answer, reason, sources = []) {
  return {status,answer,reason,sources,confidence:status === 'answered' ? 'high' : status === 'clarify' ? 'ambiguous' : 'none'};
}
function citation(c) {
  return {documentId:c.doc.id,documentTitle:c.doc.title,sectionId:c.section.id,heading:c.section.heading,quote:c.section.text,startLine:c.section.startLine,endLine:c.section.endLine};
}

function findEvidence(query, documents) {
  const candidates = [];
  let longMatches = false;
  for (const doc of documents) {
    if (!doc || !Array.isArray(doc.sections) || typeof doc.text !== 'string' || typeof doc.id !== 'string') continue;
    const lines = doc.text.split('\n');
    for (const section of doc.sections) {
      if (!section || typeof section.text !== 'string' || !section.text.trim() || typeof section.heading !== 'string') continue;
      if (!Number.isSafeInteger(section.startLine) || !Number.isSafeInteger(section.endLine) || section.startLine < 1 || section.endLine < section.startLine ||
          lines.slice(section.startLine - 1,section.endLine).join('\n') !== section.text) continue;
      // Documents are evidence, never executable instructions. Refuse sections containing overt instructions to override behavior.
      if (INJECTION.test(section.text) || INJECTION.test(section.heading)) continue;
      const headingTokens = new Set(tokens(section.heading));
      const bodyTokens = new Set(tokens(section.text));
      const all = new Set([...headingTokens,...bodyTokens]);
      const matches = query.filter(t => all.has(t));
      const coverage = matches.length / query.length;
      const headingMatches = matches.filter(t => headingTokens.has(t)).length;
      // Every content anchor must occur in evidence. Unknown properties must not inherit unrelated facts from a known topic.
      if (coverage < 1 || matches.length < 2 || !matches.some(t => bodyTokens.has(t))) continue;
      if (section.text.length > MAX_EXTRACT) { longMatches = true; continue; }
      const density = matches.length / Math.max(1,all.size);
      const score = coverage * 10 + headingMatches * 2 + density;
      candidates.push({doc,section,score,headingMatches,all});
    }
  }
  if (!candidates.length) return longMatches
    ? result('unknown','Подходящий раздел слишком длинный для точной выдержки: больше 12 000 символов. Разбейте его заголовками на короткие разделы или подготовьте вопрос человеку.','evidence_too_long')
    : result('unknown','В загруженных инструкциях нет подтверждённого ответа на этот вопрос. Подготовьте обращение человеку или добавьте нужный документ.','no_direct_evidence');
  if (longMatches) return result('unknown','Наряду с короткими фрагментами найден подходящий раздел длиннее 12 000 символов. Без его проверки нельзя выбрать действующий источник. Разбейте длинный раздел заголовками или подготовьте вопрос человеку.','evidence_too_long');
  candidates.sort((a,b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id) || a.section.startLine - b.section.startLine);
  const top = candidates[0];
  // Any differing fully matching passage is ambiguous, including a second section in the same document.
  // Lexical matching cannot decide whether these are semantic contradictions or complementary facts.
  const competing = candidates.find((c,i) => i > 0 && c.section.text.trim() !== top.section.text.trim());
  if (competing) return result('clarify','Найдены различающиеся фрагменты по этому вопросу. Алгоритм не определяет, противоречат они друг другу или дополняют ответ. Проверьте оба источника и уточните действующую инструкцию либо подготовьте вопрос человеку.','conflicting_evidence',[citation(top),citation(competing)]);
  if (/(?:не (?:определен|указан|описан)|нет (?:сведений|информации))/iu.test(top.section.text)) return result('unknown','В найденной инструкции прямо указано, что этих сведений нет. Можно подготовить вопрос человеку.','explicitly_missing',[citation(top)]);
  // An answer is always an exact extract; no unsupported inference is added.
  // At most two identical supporting sources keep the ticket/answer size bounded.
  return result('answered',top.section.text,'direct_extract',candidates.slice(0,2).map(citation));
}

/** Return literal evidence only. No model, remote API, arithmetic or instruction execution. */
export function answerQuestion(question, documents = []) {
  if (typeof question !== 'string' || !question.trim()) return result('clarify','Напишите вопрос по загруженным инструкциям.','empty_question');
  if (question.length > MAX_QUESTION) return result('clarify','Сократите вопрос до 1200 символов и оставьте одну тему.','question_too_long');
  if (INJECTION.test(question)) return result('unknown','В инструкциях нет подтверждённого ответа на этот запрос. Можно подготовить вопрос человеку.','unsupported_instruction');
  if (!Array.isArray(documents) || !documents.length) return result('unknown','База пуста. Загрузите инструкцию или подготовьте вопрос человеку.','empty_knowledge_base');
  const query = [...new Set(tokens(question))];
  if (query.length < 2) return result('clarify','Уточните вопрос: что именно нужно узнать и о каком процессе?','question_too_broad');
  const direct = findEvidence(query,documents);
  if (direct.reason !== 'no_direct_evidence') return direct;

  // Two explicit independent clauses may be answered by two literal extracts.
  // Never silently answer only the known half of a question.
  const clauses = question.split(/\s+(?:и|а также)\s+/iu);
  if (clauses.length !== 2) return direct;
  const queries = clauses.map(part => [...new Set(tokens(part))]);
  if (queries.some(part => part.length < 2)) return direct;
  const parts = queries.map(part => findEvidence(part,documents));
  if (parts.some(part => part.status === 'unknown')) return direct;
  if (parts.some(part => part.status === 'clarify')) {
    const sources = parts.find(part => part.status === 'clarify').sources;
    return result('clarify','Одна из частей вопроса имеет несколько различающихся источников. Уточните её отдельно или подготовьте вопрос человеку.','conflicting_evidence',sources);
  }
  const sources = parts.map(part => part.sources[0]);
  return result('answered',sources.map(source => source.quote).join('\n\n'),'multiple_extracts',sources);
}
