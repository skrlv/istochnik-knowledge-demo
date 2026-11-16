// Optional focused browser checks. Standard npm test needs no external packages.
// Use an installed Playwright/Chromium; PLAYWRIGHT_MODULE can point to index.mjs.
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from '../server/server.js';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const checks=[];
let server,temporary,browser,failure;
const check=(name,actual,expected=true)=>{assert.deepEqual(actual,expected,name);checks.push({name,pass:true});};
const file=(name,text)=>({name,mimeType:'text/plain',buffer:Buffer.from(text)});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
let url=process.argv[2];
try{
  if(!url){
    temporary=await mkdtemp(path.join(os.tmpdir(),'istochnik-browser-'));
    server=await createServer({rootDir:fileURLToPath(new URL('../',import.meta.url)),dataDir:temporary});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    url=`http://127.0.0.1:${server.address().port}/`;
  }
  browser=await chromium.launch({headless:true});
  for(const action of ['upload','clear','privacy-clear']){
    const context=await browser.newContext();const page=await context.newPage();
    const requested=deferred(),release=deferred();
    page.setDefaultTimeout(7000);page.on('dialog',dialog=>dialog.accept());
    await page.route('**/data/demo-documents.json',async route=>{
      requested.resolve();const response=await route.fetch();await release.promise;await route.fulfill({response});
    });
    try{
      await page.goto(url,{waitUntil:'commit'});await requested.promise;
      if(action==='upload'){
        await page.locator('#upload').setInputFiles(file('arrival.md','# Учебный проход\nДля учебного прохода используйте синий пропуск.'));
        await page.waitForFunction(()=>document.querySelector('#doc-count').textContent==='1');
      }else{
        await page.locator(action==='clear'?'#docs-clear':'#privacy-clear').click();
      }
      const before=await page.locator('.doc-name').allTextContents();
      check(`initial-${action}: user mutation applied`,before,action==='upload'?['arrival']:[]);
      release.resolve();await page.waitForLoadState('networkidle');
      check(`initial-${action}: delayed demo cannot overwrite`,await page.locator('.doc-name').allTextContents(),before);
    }finally{release.resolve();await context.close();}
  }
  const context=await browser.newContext();const page=await context.newPage();const errors=[];
  page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(String(error)));
  try{
    await page.goto(url,{waitUntil:'networkidle'});
    const ask=async question=>{await page.locator('#question').fill(question);await page.locator('#ask-button').click();await page.locator('.result').waitFor();};
    const text='\r\n\r\n# Доступ в лабораторию\r\n\r\n  Для доступа в лабораторию подайте заявку куратору.  \r\n\tДоступ в лабораторию действует один день.\t\r\n';
    const expected=text.replace(/\r\n?/g,'\n').split('\n').slice(4,6).join('\n');
    await page.locator('#upload').setInputFiles(file('spacing.md',text));
    await page.waitForFunction(()=>document.querySelector('#doc-count').textContent==='5');
    await ask('Как получить доступ в лабораторию?');
    check('spacing: exact extract',await page.locator('.answer-text').textContent(),expected);
    check('spacing: original line range',(await page.locator('.source-link small').textContent()).includes('5–6'));
    await page.locator('.source-link').click();
    const source=page.getByRole('dialog',{name:'spacing',exact:true});
    check('source: accessible name',await source.count(),1);
    check('source: exact marked text',(await source.locator('.marked .line-text').allTextContents()).join('\n'),expected);
    checks.push({name:'source: accessibility tree',pass:true,snapshot:await source.ariaSnapshot()});
    await page.keyboard.press('Escape');
    await page.locator('.result-action').click();
    const handoff=page.getByRole('dialog',{name:'Проверьте обращение',exact:true});
    check('handoff: accessible name',await handoff.count(),1);
    await page.locator('#ticket-evidence summary').click();
    check('handoff: exact source snapshot',await page.locator('#ticket-source-preview .quote-preview').textContent(),expected);
    await page.locator('#ticket-question').fill('Учебное уточнение доступа');
    await page.locator('#handoff-form button[type=submit]').click();
    const queue=page.getByRole('dialog',{name:'Вопросы для человека',exact:true});await queue.waitFor();
    check('queue: accessible name',await queue.count(),1);
    await page.locator('.ticket details summary').first().click();
    const saved=await page.locator('.ticket details .quote-preview').first().locator('..').locator('.quote-preview').allTextContents();
    check('queue: exact saved source snapshot',saved.includes(expected));
    await page.keyboard.press('Escape');
    await page.locator('#help-open').click();
    check('help: accessible name',await page.getByRole('dialog',{name:'Сначала факт, потом ответ',exact:true}).count(),1);
    await page.keyboard.press('Escape');
    await ask('Как получить доступ в CRM?');
    check('public path: known answer',await page.locator('.result.answered').count(),1);
    await ask('Какой бюджет на отпуск?');
    check('public path: unknown refused',await page.locator('.result.unknown').count(),1);
    check('no page JavaScript errors',errors,[]);
  }finally{await context.close();}
}catch(error){failure=String(error);throw error;}finally{
  if(browser)await browser.close();
  if(server)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  if(temporary)await rm(temporary,{recursive:true,force:true});
  const result={checked_at:new Date().toISOString(),url,status:failure?'failed':'passed',error:failure,checks,passed:checks.length,browser_closed:true,server_closed:true};
  if(process.env.BROWSER_REPORT)await writeFile(process.env.BROWSER_REPORT,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}
