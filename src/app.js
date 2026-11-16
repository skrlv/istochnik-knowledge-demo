import {parseDocument,answerQuestion} from './engine.js';

const $ = id => document.getElementById(id);
const KEY = `istochnik-v1:${new URL('../',import.meta.url).pathname}`;
const MAX_DOC = 100000, MAX_TOTAL = 500000, MAX_DOCS = 30, MAX_TICKETS = 500;
let documents = [], tickets = [], last = null, lastQuestion = '', draftSources = [], replacementId = null;
let persistent = false, serverMode = false, busy = false, revision = 0, questionRevision = 0, mutationToken = 0;
const statusNames = {new:'Новый',in_progress:'В работе',closed:'Закрыт'};
const el = (tag,cls,text) => {const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const uid = () => crypto.randomUUID();
const rawDoc = d => ({id:d.id,title:d.title,filename:d.filename,text:d.text,demo:d.demo});
const showNotice = (id,message) => {$(id).textContent=message;$(id).hidden=!message;};
const showDialog = id => {if(!$(id).open)$(id).showModal();};
const fail = e => e instanceof Error ? e.message : 'Действие не выполнено.';
const storageDescription = () => serverMode ? 'Локальный сервер: очередь сохраняется на этом компьютере в .local-data/tickets.json. Внешних отправок нет.' : persistent ? 'Очередь сохраняется без шифрования в этом браузере. Внешних отправок нет.' : 'Очередь хранится только в памяти этой вкладки и исчезнет после обновления страницы. Для сохранения скачайте JSON или включите хранение в браузере.';

function validateDocuments(raw) {
  if(!Array.isArray(raw)||raw.length>MAX_DOCS)throw new Error('В базе может быть до 30 документов.');
  let total=0;const ids=new Set();
  return raw.map(d=>{
    if(!d||typeof d.id!=='string'||d.id.length>100||ids.has(d.id)||typeof d.text!=='string'||d.text.length>MAX_DOC)throw new Error('Повреждённые данные документа.');
    ids.add(d.id);total+=d.text.length;
    if(total>MAX_TOTAL)throw new Error('Общий объём базы — до 500 000 символов.');
    return parseDocument(d);
  });
}
function validSources(sources){
  return Array.isArray(sources)&&sources.length<=10&&sources.every(s=>s&&typeof s.documentTitle==='string'&&typeof s.heading==='string'&&typeof s.quote==='string'&&s.quote.length<=15000&&Number.isInteger(s.startLine)&&Number.isInteger(s.endLine));
}
function validateTickets(raw){
  if(!Array.isArray(raw)||raw.length>MAX_TICKETS)throw new Error('Некорректная очередь.');
  return raw.map(t=>{
    if(!t||typeof t.id!=='string'||typeof t.question!=='string'||t.question.length>2000||typeof t.answer!=='string'||t.answer.length>30000||typeof t.contact!=='string'||t.contact.length>250||!validSources(t.sources)||!Object.hasOwn(statusNames,t.status)||!Number.isFinite(Date.parse(t.createdAt)))throw new Error('Некорректное обращение в сохранённых данных.');
    return {...t};
  });
}
function persist(){
  if(!persistent)return;
  try{localStorage.setItem(KEY,JSON.stringify({version:1,documents:documents.map(rawDoc),tickets:serverMode?[]:tickets}));}
  catch{persistent=false;$('persist').checked=false;try{localStorage.removeItem(KEY);}catch{}updateMode();showNotice('upload-notice','Браузер не сохранил данные: хранилище недоступно или заполнено. Они остались только в памяти вкладки; скачайте очередь при необходимости.');}
}
function updateMode(){
  $('mode-label').textContent=serverMode?'Сервер на этом компьютере':persistent?'Сохранение в браузере':'Только в этой вкладке';
  $('mode-detail').textContent=serverMode?'Вопросы и инструкции обрабатывает локальный сервер. Очередь записывается в файл на этом компьютере.':persistent?'Документы и очередь сохранены в localStorage без шифрования. Они доступны этому браузеру.':'Документы не отправляются на сервер. Обновление страницы удалит ваши изменения.';
  $('mode-pill').textContent=serverMode?'Локальный сервер':'Локальный поиск';
  $('ticket-storage').textContent=storageDescription();$('queue-explainer').textContent=storageDescription();
  $('queue-clear').hidden=serverMode;
}
function invalidate(){
  revision++;mutationToken++;
  last=null;lastQuestion='';draftSources=[];
  if($('source-dialog').open)$('source-dialog').close();
  if($('handoff-dialog').open)$('handoff-dialog').close();
  if(location.hash.startsWith('#source='))history.replaceState(null,'',location.pathname+location.search);
  const block=el('div','answer-placeholder');block.append(el('h3','', 'База обновлена'),el('p','', 'Задайте вопрос заново: прежний ответ больше не используется.'));
  $('answer-region').replaceChildren(block);
}
function renderDocs(){
  $('doc-count').textContent=documents.length;
  $('document-list').replaceChildren();
  if(!documents.length)$('document-list').append(el('p','empty','База пуста. Добавьте текстовую инструкцию.'));
  for(const doc of documents){
    const card=el('article','doc-card');const open=el('button','doc-main');open.type='button';open.setAttribute('aria-label',`Открыть документ: ${doc.title}`);
    const text=el('span');text.append(el('span','doc-name',doc.title),el('span','doc-meta',`${doc.sections.length} разд. · ${doc.demo?'учебный пример':'ваш документ'}`));open.append(el('span','doc-icon','TXT'),text);open.addEventListener('click',()=>openSource(doc.id));
    const actions=el('div','doc-actions');const replace=el('button','', 'Заменить');replace.type='button';replace.setAttribute('aria-label',`Заменить: ${doc.title}`);replace.addEventListener('click',()=>{replacementId=doc.id;$('replace-upload').click();});
    const remove=el('button','danger','Удалить');remove.type='button';remove.setAttribute('aria-label',`Удалить: ${doc.title}`);remove.addEventListener('click',()=>{if(confirm(`Удалить «${doc.title}» из базы? Снимки в обращениях сохранятся отдельно.`)){documents=documents.filter(d=>d.id!==doc.id);changed();}});
    actions.append(replace,remove);card.append(open,actions);$('document-list').append(card);
  }
}
function changed(){invalidate();renderDocs();persist();}
async function readUpload(file,id){
  if(!/\.(md|txt)$/i.test(file.name))throw new Error('Поддерживаются только .txt и .md.');
  if(file.size===0)throw new Error('Файл пуст.');
  if(file.size>400000)throw new Error('Файл слишком большой: до 100 000 символов UTF-8.');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch{throw new Error('Файл повреждён или не в UTF-8. Сохраните его заново как текст UTF-8.');}
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))throw new Error('Обнаружены бинарные или управляющие символы. Нужен обычный текст.');
  if(text.length>MAX_DOC)throw new Error('В документе больше 100 000 символов.');
  return parseDocument({id:id||uid(),title:file.name.replace(/\.(txt|md)$/i,'').slice(0,200),filename:file.name,text,demo:false});
}
async function upload(files,replaceId=null){
  if(!files?.length)return;
  const operation=++mutationToken;const errors=[];let added=0;let nextDocuments=[...documents];
  for(const file of files){
    try{
      const doc=await readUpload(file,replaceId);
      if(operation!==mutationToken)return;
      const candidate=replaceId?nextDocuments.map(d=>d.id===replaceId?doc:d):[...nextDocuments,doc];
      if(replaceId&&!nextDocuments.some(d=>d.id===replaceId))throw new Error('Документ для замены уже удалён.');
      nextDocuments=validateDocuments(candidate);added++;
    }catch(e){errors.push(`${file.name}: ${fail(e)}`);}
  }
  if(operation!==mutationToken)return;
  if(added){documents=nextDocuments;changed();}
  showNotice('upload-notice',[added?`${replaceId?'Заменено':'Добавлено'} документов: ${added}.`:null,...errors].filter(Boolean).join('\n'));
}
function sourceURL(s){return `#source=${encodeURIComponent(s.documentId)}&section=${encodeURIComponent(s.sectionId||'')}`;}
function renderResult(r){
  const block=el('article',`result ${r.status}`);const label=el('div','result-label');label.append(el('span','',r.status==='answered'?'✓':'?'),document.createTextNode(r.status==='answered'?'НАЙДЕНО В ИНСТРУКЦИЯХ':r.status==='clarify'?'НУЖНО УТОЧНЕНИЕ':'ПОДТВЕРЖДЕНИЯ НЕТ'));
  const body=el('div','answer-body');body.append(el('p','answer-text',r.answer));block.append(label,body);
  block.append(el('p','result-note',r.status==='answered'?'Дословная выдержка. Проверьте применимость правила по источнику.':'Помощник не выбирает правило и не добавляет отсутствующие сведения.'));
  const sources=el('div','source-links');
  for(const s of r.sources){const link=el('a','source-link');link.href=sourceURL(s);const text=el('span','',s.documentTitle);text.append(el('small','',`${s.heading} · строки ${s.startLine}–${s.endLine}`));link.append(text,el('span','','↗'));link.addEventListener('click',e=>{e.preventDefault();history.replaceState(null,'',sourceURL(s));openSource(s.documentId,s.sectionId);});sources.append(link);}
  block.append(sources);const handoff=el('button','secondary result-action','Подготовить обращение человеку →');handoff.type='button';handoff.addEventListener('click',prepareHandoff);block.append(handoff);$('answer-region').replaceChildren(block);
}
async function api(url,body,method='POST'){
  const response=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'Локальная операция не выполнена.');return data;
}
async function ask(){
  if(busy)return;if(!$('ask-form').reportValidity())return;
  const question=$('question').value.trim();if(!question){$('question').setCustomValidity('Напишите содержательный вопрос.');$('question').reportValidity();return;}
  busy=true;$('ask-button').disabled=true;last=null;lastQuestion='';const requestRevision=revision,requestQuestion=questionRevision;
  try{const r=serverMode?await api('./api/answer',{question,documents:documents.map(rawDoc)}):answerQuestion(question,documents);if(requestRevision!==revision||requestQuestion!==questionRevision||$('question').value.trim()!==question)return;last=r;lastQuestion=question;renderResult(r);}
  catch(e){if(requestRevision===revision&&requestQuestion===questionRevision)$('answer-region').replaceChildren(el('p','notice',`Поиск не выполнен. ${fail(e)}`));}
  finally{busy=false;$('ask-button').disabled=false;}
}
function openSource(id,sectionId){
  const doc=documents.find(d=>d.id===id);if(!doc){showNotice('upload-notice','Источник больше не находится в базе. Задайте вопрос заново.');return;}
  const section=doc.sections.find(s=>s.id===sectionId);$('source-title').textContent=doc.title;$('source-meta').textContent=`${doc.filename} · ${doc.demo?'вымышленный учебный документ':'загруженный документ'}${section?` · строки ${section.startLine}–${section.endLine}`:''}`;
  const fragment=document.createDocumentFragment();doc.text.split('\n').forEach((line,i)=>{const row=el('div',`source-line${section&&i+1>=section.startLine&&i+1<=section.endLine?' marked':''}`);const num=el('span','line-number',i+1);num.setAttribute('aria-label',`Строка ${i+1}`);row.append(num,el('span','line-text',line||' '));fragment.append(row);});$('source-lines').replaceChildren(fragment);showDialog('source-dialog');
  requestAnimationFrame(()=>{const target=$('source-lines').querySelector('.marked');$('source-lines').scrollTop=target?target.offsetTop-$('source-lines').offsetTop-30:0;});
}
function prepareHandoff(){
  if(busy)return;
  const current=$('question').value.trim();const consistent=last&&lastQuestion===current;
  $('ticket-question').value=current;$('ticket-answer').value=consistent?last.answer:'';$('ticket-contact').value='';$('ticket-sources').checked=true;
  draftSources=consistent?structuredClone(last.sources):[];
  $('ticket-source-preview').replaceChildren();
  if(!draftSources.length)$('ticket-source-preview').append(el('p','','Источников к этому обращению нет.'));
  for(const s of draftSources){$('ticket-source-preview').append(el('strong','',`${s.documentTitle} / ${s.heading} / строки ${s.startLine}–${s.endLine}`),el('p','quote-preview',s.quote));}
  $('ticket-evidence').open=false;showNotice('ticket-notice','');updateMode();showDialog('handoff-dialog');
}
function ticketFields(){
  if(!$('handoff-form').reportValidity())return null;
  const question=$('ticket-question').value.trim();if(!question){showNotice('ticket-notice','Вопрос не должен состоять только из пробелов.');return null;}
  return {question,answer:$('ticket-answer').value.trim(),contact:$('ticket-contact').value.trim(),sources:$('ticket-sources').checked?structuredClone(draftSources):[]};
}
function download(name,value){const a=el('a');const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json;charset=utf-8'}));a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function saveTicket(){
  const fields=ticketFields();if(!fields)return;
  const button=$('handoff-form').querySelector('button[type=submit]');button.disabled=true;
  try{
    if(serverMode){const {ticket}=await api('./api/tickets',fields);tickets=[ticket,...tickets];}
    else{if(tickets.length>=MAX_TICKETS)throw new Error('Очередь заполнена: максимум 500 вопросов.');const now=new Date().toISOString();tickets.unshift({id:uid(),...fields,status:'new',createdAt:now,updatedAt:now});persist();}
    renderQueue();$('handoff-dialog').close();showDialog('queue-dialog');
  }catch(e){showNotice('ticket-notice',fail(e));}finally{button.disabled=false;}
}
function ticketDate(value){return new Date(value).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});}
function renderQueue(){
  $('queue-count').textContent=tickets.length;$('ticket-list').replaceChildren();updateMode();
  if(!tickets.length)$('ticket-list').append(el('p','empty','Пока нет вопросов. Обращение можно подготовить под ответом помощника.'));
  for(const t of tickets){
    const item=el('article','ticket');item.append(el('h3','',t.question));const meta=el('div','ticket-meta');meta.append(el('span','tiny muted',`${ticketDate(t.createdAt)} · ${t.id.slice(0,8)}`));const select=el('select');select.setAttribute('aria-label',`Статус: ${t.question}`);for(const [value,name]of Object.entries(statusNames)){const option=el('option','',name);option.value=value;select.append(option);}select.value=t.status;
    select.addEventListener('change',async()=>{const before=t.status;select.disabled=true;try{if(serverMode){const {ticket}=await api(`./api/tickets/${t.id}`,{status:select.value},'PATCH');Object.assign(t,ticket);}else{t.status=select.value;t.updatedAt=new Date().toISOString();persist();}showNotice('queue-notice','');}catch(e){select.value=before;showNotice('queue-notice',fail(e));}finally{select.disabled=false;}});meta.append(select);item.append(meta);
    const details=el('details');details.append(el('summary','','Контекст и снимки источников'));if(t.answer)details.append(el('p','quote-preview',t.answer));if(t.contact)details.append(el('p','small',`Контакт: ${t.contact}`));for(const s of t.sources)details.append(el('strong','small',`${s.documentTitle} · ${s.heading} · ${s.startLine}–${s.endLine}`),el('p','quote-preview',s.quote));details.append(el('p','tiny muted','Это снимки на момент сохранения обращения. Они не обновляются вместе с базой.'));item.append(details);
    const actions=el('div','ticket-actions');const exportOne=el('button','text-button','Скачать JSON');exportOne.addEventListener('click',()=>download(`istochnik-${t.id}.json`,t));actions.append(exportOne);if(!serverMode){const del=el('button','text-button danger','Удалить');del.addEventListener('click',()=>{if(confirm('Удалить обращение и его снимки источников из этой очереди?')){tickets=tickets.filter(v=>v.id!==t.id);persist();renderQueue();}});actions.append(del);}item.append(actions);$('ticket-list').append(item);
  }
}
async function openQueue(){showNotice('queue-notice','');if(serverMode){try{const data=await api('./api/tickets',null,'GET');tickets=validateTickets(data.tickets);}catch(e){showNotice('queue-notice',fail(e));}}renderQueue();showDialog('queue-dialog');}
async function loadDemo(){const response=await fetch('./data/demo-documents.json');if(!response.ok)throw new Error('Не удалось загрузить пример. Можно загрузить свой TXT или MD.');return validateDocuments(await response.json());}

function questionChanged(){questionRevision++;$('question').setCustomValidity('');last=null;lastQuestion='';draftSources=[];if($('answer-region').querySelector('.result')||busy){const block=el('div','answer-placeholder');block.append(el('h3','','Вопрос изменён'),el('p','','Нажмите «Найти ответ», чтобы проверить новый вопрос.'));$('answer-region').replaceChildren(block);}}
$('ask-form').addEventListener('submit',e=>{e.preventDefault();ask();});$('question').addEventListener('input',questionChanged);
for(const button of document.querySelectorAll('[data-question]'))button.addEventListener('click',()=>{$('question').value=button.dataset.question;questionChanged();ask();});
$('upload').addEventListener('change',async e=>{await upload(e.target.files);e.target.value='';});$('replace-upload').addEventListener('change',async e=>{await upload(e.target.files,replacementId);e.target.value='';replacementId=null;});
$('demo-load').addEventListener('click',async()=>{if(!confirm('Заменить текущую базу четырьмя учебными документами? Снимки в очереди останутся.'))return;const operation=++mutationToken;try{const demo=await loadDemo();if(operation!==mutationToken)return;documents=demo;changed();showNotice('upload-notice','Учебная база восстановлена.');}catch(e){if(operation===mutationToken)showNotice('upload-notice',fail(e));}});
$('docs-clear').addEventListener('click',()=>{if(confirm('Очистить все документы? Снимки цитат в очереди останутся отдельно.')){documents=[];changed();showNotice('upload-notice','База очищена.');}});
$('persist').addEventListener('change',()=>{persistent=$('persist').checked;if(persistent)persist();else{try{localStorage.removeItem(KEY);}catch{} }updateMode();});
$('privacy-clear').addEventListener('click',()=>{if(!confirm('Удалить сохранённые данные браузера и очистить документы и браузерную очередь этого проекта? Серверный файл и скачанные JSON останутся.'))return;try{localStorage.removeItem(KEY);}catch{showNotice('upload-notice','Браузер не разрешил очистку хранилища. Проверьте настройки сайта.');return;}persistent=false;$('persist').checked=false;documents=[];if(!serverMode)tickets=[];changed();renderQueue();updateMode();showNotice('upload-notice','Данные этого проекта в браузере удалены.');});
$('manual-handoff').addEventListener('click',prepareHandoff);$('handoff-form').addEventListener('submit',e=>{e.preventDefault();saveTicket();});$('ticket-export').addEventListener('click',()=>{const fields=ticketFields();if(fields){download('istochnik-draft.json',{type:'human-handoff-draft',exportedAt:new Date().toISOString(),...fields});showNotice('ticket-notice','JSON скачан. Вы можете передать его человеку самостоятельно. Сообщение никому не отправлено.');}});
$('queue-open').addEventListener('click',openQueue);$('help-open').addEventListener('click',()=>showDialog('help-dialog'));
$('queue-export').addEventListener('click',()=>download('istochnik-queue.json',{type:'local-queue-snapshot',exportedAt:new Date().toISOString(),tickets}));
$('queue-clear').addEventListener('click',()=>{if(!serverMode&&confirm('Удалить все обращения и их снимки источников из браузерной очереди?')){tickets=[];persist();renderQueue();}});
for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>button.closest('dialog').close());
$('source-dialog').addEventListener('close',()=>{if(location.hash.startsWith('#source='))history.replaceState(null,'',location.pathname+location.search);});
function routeSource(){if(location.hash.startsWith('#source=')){const p=new URLSearchParams(location.hash.slice(1));openSource(p.get('source'),p.get('section'));}}
window.addEventListener('hashchange',routeSource);

async function init(){
  let restored=false;
  try{const saved=localStorage.getItem(KEY);if(saved){const data=JSON.parse(saved);if(data.version!==1)throw new Error('Неизвестная версия сохранения.');documents=validateDocuments(data.documents);tickets=validateTickets(data.tickets);persistent=true;restored=true;$('persist').checked=true;}}
  catch{persistent=false;showNotice('upload-notice','Сохранённые данные недоступны или повреждены. Они не использованы. Можно удалить их кнопкой «Удалить сохранённое».');}
  if(!restored){
    const initialMutation=mutationToken;
    try{const demo=await loadDemo();if(initialMutation===mutationToken)documents=demo;}
    catch(e){if(initialMutation===mutationToken)showNotice('upload-notice',fail(e));}
  }
  if(['localhost','127.0.0.1','[::1]'].includes(location.hostname)){try{const r=await api('./api/health',null,'GET');serverMode=r.ok===true&&r.mode==='local-server';if(serverMode){tickets=validateTickets((await api('./api/tickets',null,'GET')).tickets);}}catch{/* Static local preview stays in browser mode. */}}
  renderDocs();renderQueue();updateMode();routeSource();
}
await init();
