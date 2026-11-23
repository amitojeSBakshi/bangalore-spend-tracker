const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');

const root = path.resolve(__dirname,'..');
const prefix = 'bglr-spend-tracker-v1';
const hashFor = (name,pin)=>{
  let h=5381;
  for(const c of `${name.trim().toLowerCase()}|${pin}`) h=((h*33)^c.charCodeAt(0))>>>0;
  return h.toString(16);
};
const ownerHash = hashFor('Test Owner','2468');
const key = `${prefix}::${ownerHash}`;
const fixedTime = new Date('2026-11-23T06:30:00Z');
const entry = (id,date,amount,category='Food',note='Test expense')=>({id,date,amount,category,note,tags:[]});
const fixture = ()=>({entries:[entry(1,'2026-08-03',806),entry(2,'2026-10-15',200),
  entry(3,'2026-11-01',100),entry(4,'2026-11-02',2000,'Sports'),
  entry(5,'2026-11-23',140),entry(6,'2026-11-23',0.1),entry(7,'2026-11-23',0.2)],
  budgets:{'2026-08':{Food:500}},salary:60000,goals:[{id:98,name:'Test goal',saved:100,target:1000}],
  nextId:100,updatedAt:1});
let browser,server,url;
let legacyMode=false;
const legacyFile = name=>execFileSync('git',['show',`9add200:${name}`],{cwd:root}).toString();
const oldHtml=legacyFile('index.html'),oldWorker=legacyFile('service-worker.js');

before(async()=>{
  server=http.createServer((req,res)=>{
    const route=new URL(req.url,'http://localhost').pathname;
    const file=route==='/'?'index.html':route.slice(1);
    if(!['index.html','manifest.json','service-worker.js'].includes(file) && !/^icons\/[a-z0-9.-]+$/.test(file)){
      res.writeHead(404);res.end();return;
    }
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.json')?'application/json':file.endsWith('.png')?'image/png':'text/html');
    res.end(legacyMode && file==='index.html'?oldHtml:legacyMode && file==='service-worker.js'?oldWorker:fs.readFileSync(path.join(root,file)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch();
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve));});

async function setup(data=fixture(),options={}){
  const context=await browser.newContext({timezoneId:'Asia/Kolkata',serviceWorkers:options.worker?'allow':'block',
    viewport:options.viewport||{width:390,height:844},colorScheme:options.scheme||'light'});
  await context.route(/fonts\.(googleapis|gstatic)\.com/,route=>route.abort());
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:fixedTime});
  await page.goto(url);
  if(data!==null){
    await page.evaluate(({prefix,key,hash,data})=>{
      localStorage.setItem(prefix+'::profiles',JSON.stringify({[hash]:{name:'Test Owner'}}));
      localStorage.setItem('activeProfileHash',hash);
      localStorage.setItem(key,typeof data==='string'?data:JSON.stringify(data));
    },{prefix,key,hash:ownerHash,data});
    await page.reload();
  }
  return {context,page,errors};
}
async function getData(page){return page.evaluate(k=>JSON.parse(localStorage.getItem(k)),key);}
async function add(page,{date='2026-11-23',amount='150',note='Lunch',category='Food'}={}){
  await page.click('[data-tab="add"]');
  await page.fill('#fDate',date);await page.fill('#fAmount',amount);
  await page.selectOption('#fCategory',category);await page.fill('#fNote',note);
  await page.click('#submitBtn');
}
async function importData(page,data){
  await page.click('[data-tab="entries"]');
  const dialogs=[];const handler=async dialog=>{dialogs.push(dialog.message());await dialog.accept();};
  page.on('dialog',handler);
  await page.setInputFiles('#importFile',{name:'test-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
  await page.waitForFunction(()=>document.getElementById('importFile').value==='');
  // FileReader dispatches after the input event has returned.
  await page.waitForFunction(()=>document.getElementById('monthlyTotals').children.length>0);
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,100)));
  page.off('dialog',handler);
  return dialogs;
}

test('legacy reproduction: split paise fail native validation and missing backup fields crash boot',async()=>{
  legacyMode=true;
  const {context,page}=await setup();
  try{
    await page.click('[data-tab="add"]');
    await page.check('#fSplitToggle');await page.fill('#fSplitTotal','1000');await page.fill('#fSplitCount','3');
    assert.equal(await page.$eval('#fAmount',el=>el.validity.stepMismatch),true);
    await page.evaluate(({key})=>localStorage.setItem(key,JSON.stringify({entries:[]})),{key});
    const error=page.waitForEvent('pageerror');
    await page.reload();
    assert.match((await error).message,/undefined/);
  }finally{legacyMode=false;await context.close();}
});

test('sample exploration, profile creation and entry gating work without Budget or Plan',async()=>{
  const {context,page,errors}=await setup(null);
  try{
    assert.deepEqual(await page.locator('.tab-btn').allTextContents(),['Overview','Overall','Add Entry','Entries']);
    assert.equal(await page.locator('#tab-budget,#tab-plan').count(),0);
    await add(page);
    assert.equal(await page.locator('#authCreate').isVisible(),true);
    assert.equal(await page.evaluate(()=>localStorage.length),0);
    await page.fill('#createName','New Visitor');await page.fill('#createPin','2468');await page.fill('#createPinConfirm','2468');
    await page.click('#createForm button[type="submit"]');
    assert.equal(await page.locator('#authConfirm').isVisible(),true,JSON.stringify({errors,form:await page.$eval('#createForm',f=>({valid:f.checkValidity(),fields:[...f.querySelectorAll('input')].map(x=>({id:x.id,value:x.value,valid:x.checkValidity()}))})),message:await page.locator('#createError').textContent()}));
    await page.fill('#confirmPinInput','2468');await page.click('#confirmForm button');
    await page.click('#greetOverlay');
    assert.match(await page.locator('#overviewCards').innerText(),/₹0/);
    await add(page);
    assert.match(await page.locator('#lastAdded').innerText(),/Added: ₹150/);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('all months have exact totals, missing months show zero, and months are selectable',async()=>{
  const {context,page,errors}=await setup();
  try{
    const totals=await page.locator('.month-total').allTextContents();
    assert.match(totals[0],/November 2026[\s\S]*₹2,240.3/);
    assert.match(totals[1],/October 2026[\s\S]*₹200/);
    assert.match(totals[2],/September 2026[\s\S]*₹0/);
    assert.match(totals[3],/August 2026[\s\S]*₹806/);
    assert.match(await page.locator('#allTimeTotal').innerText(),/₹3,246.3/);
    await page.click('[data-month="2026-08"]');
    assert.equal(await page.locator('#overviewMonthLabel').innerText(),'August 2026');
    assert.match(await page.locator('#overviewCards').innerText(),/₹806/);
    await page.click('[data-month="2026-09"]');
    assert.match(await page.locator('#overviewCards').innerText(),/₹0/);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('November additions select the right month, edit/delete update totals and reload retains history',async()=>{
  const {context,page,errors}=await setup();
  try{
    await page.click('[data-month="2026-08"]');
    await add(page,{date:'2026-11-24',amount:'149.25'});
    await page.click('[data-tab="overview"]');
    assert.equal(await page.locator('#overviewMonthLabel').innerText(),'November 2026');
    assert.match(await page.locator('.card.wide').innerText(),/₹2,389.55/);
    await page.reload();
    assert.equal((await getData(page)).entries.length,8);
    await page.click('[data-tab="entries"]');
    await page.locator('.entry-row').first().getByLabel('Edit entry').click();
    await page.fill('#fAmount','160.50');await page.click('#submitBtn');
    assert.match(await page.locator('#lastAdded').innerText(),/Updated: ₹160.5/);
    await page.click('[data-tab="entries"]');
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('.entry-row').first().getByLabel('Delete entry').click();
    assert.equal((await getData(page)).entries.length,7);
    assert.deepEqual((await getData(page)).goals,fixture().goals);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('Monday and cross-month weeks include all local calendar dates; year rollover works',async()=>{
  const {context,page}=await setup();
  try{
    const week=page.locator('.card').filter({hasText:'This week so far'});
    assert.match(await week.innerText(),/₹140.3/);
    assert.match(await page.locator('#weeklyTable').innerText(),/23 Nov – 29 Nov/);
    await page.clock.setFixedTime(new Date('2026-11-01T06:30:00Z'));
    await page.reload();
    // 1 November is a Sunday, so this week's prior-month expenses must be included.
    const old=await getData(page);old.entries.push(entry(101,'2026-10-31',50));
    await page.evaluate(({key,old})=>localStorage.setItem(key,JSON.stringify(old)),{key,old});await page.reload();
    assert.match(await page.locator('.card').filter({hasText:'This week so far'}).innerText(),/₹150/);
    const dateChecks=await page.evaluate(()=>({dec:shiftMonth('2026-11',1),jan:shiftMonth('2026-12',1),past:shiftMonth('2026-01',-1),leap:isValidDate('2028-02-29'),invalid:isValidDate('2026-11-31')}));
    assert.deepEqual(dateChecks,{dec:'2026-12',jan:'2027-01',past:'2025-12',leap:true,invalid:false});
  }finally{await context.close();}
});

test('split bills accept decimal shares and a following unsplit entry still saves',async()=>{
  const {context,page,errors}=await setup();
  try{
    await page.click('[data-tab="add"]');await page.fill('#fDate','2026-11-23');
    await page.check('#fSplitToggle');await page.fill('#fSplitTotal','1000');await page.fill('#fSplitCount','3');
    assert.equal(await page.inputValue('#fAmount'),'333.33');
    assert.equal(await page.$eval('#entryForm',el=>el.checkValidity()),true);
    await page.click('#submitBtn');
    assert.equal((await getData(page)).entries.at(-1).amount,333.33);
    await add(page,{amount:'20.25'});
    assert.equal((await getData(page)).entries.length,9);
    assert.equal((await getData(page)).entries.at(-1).amount,20.25);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('custom labels and notes render as text and cannot corrupt the layout or execute markup',async()=>{
  const data=fixture();
  const label='Other " & <img src=x onerror="window.bad=1">';
  data.entries.push(entry(20,'2026-11-23',25,label,'<img src=x onerror="window.bad=2">'));
  data.entries.push(entry(21,'2026-11-23',30,'__proto__','constructor'));
  const {context,page,errors}=await setup(data);
  try{
    assert.equal(await page.locator('#categoryBars img').count(),0);
    assert.equal(await page.evaluate(()=>window.bad),undefined);
    await page.locator('#categoryBars .cat-row').filter({hasText:'Other "'}).click();
    assert.match(await page.locator('.cat-detail').innerText(),/<img/);
    await page.click('[data-tab="entries"]');
    assert.equal(await page.locator('#entriesTable img').count(),0);
    await page.selectOption('#filterCategory',label);
    assert.equal(await page.locator('.entry-row').count(),1);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('minimal old backups normalize amounts/IDs, preserve metadata, and malformed imports cannot replace data',async()=>{
  const {context,page,errors}=await setup();
  try{
    const dialogs=await importData(page,{entries:[entry('1','2026-11-20','125.50','Training'),entry('1','2026-11-21','50')],goals:[{id:9,name:'Test'}]});
    assert.ok(dialogs.includes('Import complete.'));
    const saved=await getData(page);
    assert.equal(saved.entries[0].amount,125.5);
    assert.equal(saved.entries[0].category,'Sports');
    assert.equal(new Set(saved.entries.map(e=>e.id)).size,2);
    assert.ok(saved.nextId>Math.max(...saved.entries.map(e=>e.id)));
    const before=JSON.stringify(saved);
    const invalid=await importData(page,{entries:[entry(1,'2026-11-31',300)]});
    assert.ok(invalid.some(x=>x.includes('invalid date')));
    assert.equal(JSON.stringify(await getData(page)),before);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('unreadable saved data is never overwritten and can be exported for recovery',async()=>{
  const raw='{broken November data';
  const {context,page,errors}=await setup(raw);
  try{
    assert.match(await page.locator('#dataStatus').innerText(),/could not be read/);
    await add(page);
    assert.equal(await page.evaluate(k=>localStorage.getItem(k),key),raw);
    assert.equal(await page.inputValue('#fAmount'),'150');
    await page.click('[data-tab="entries"]');
    const downloadEvent=page.waitForEvent('download');await page.click('#exportBtn');
    const download=await downloadEvent;
    assert.equal(fs.readFileSync(await download.path(),'utf8'),raw);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('failed writes retain the form and show an error without a false success',async()=>{
  const {context,page}=await setup();
  try{
    const before=await getData(page);
    await page.evaluate(k=>{
      const original=Storage.prototype.setItem;
      Storage.prototype.setItem=function(name,value){if(name===k) throw new DOMException('Full','QuotaExceededError');return original.call(this,name,value);};
    },key);
    await add(page,{amount:'222'});
    assert.match(await page.locator('#dataStatus').innerText(),/could not be saved/);
    assert.equal(await page.inputValue('#fAmount'),'222');
    assert.equal(await page.locator('#lastAdded').innerText(),'');
    assert.deepEqual(await getData(page),before);
    assert.equal(await page.evaluate(()=>state.entries.length),before.entries.length);
  }finally{await context.close();}
});

test('stale tabs cannot overwrite a newer saved entry',async()=>{
  const {context,page}=await setup();
  try{
    const other=await context.newPage();await other.clock.install({time:fixedTime});await other.goto(url);
    await add(other,{amount:'777'});
    await add(page,{amount:'888'});
    assert.match(await page.locator('#dataStatus').innerText(),/another window/);
    assert.equal(await page.inputValue('#fAmount'),'888');
    const data=await getData(page);
    assert.equal(data.entries.at(-1).amount,777);
    assert.equal(data.entries.length,8);
  }finally{await context.close();}
});

test('logging out clears edit IDs, search and filters before another profile signs in',async()=>{
  const {context,page,errors}=await setup();
  try{
    await page.click('[data-tab="entries"]');await page.fill('#searchNotes','Test expense');
    await page.locator('.entry-row').first().getByLabel('Edit entry').click();
    await page.click('#lockBtn');
    assert.equal(await page.inputValue('#editId'),'');
    assert.equal(await page.inputValue('#searchNotes'),'');
    assert.equal(await page.locator('#tab-overview').isVisible(),true);
    await page.click('#demoSignInBtn');
    await page.fill('#signInName','Test Owner');await page.fill('#pinInput','9999');await page.click('#signInForm button');
    assert.equal(await page.locator('#signInError').isVisible(),true);
    await page.fill('#pinInput','2468');await page.click('#signInForm button');await page.click('#greetOverlay');
    assert.deepEqual(await getData(page),fixture());
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('historical recurring configuration does not add hidden expenses after removing Budget and Plan',async()=>{
  const data=fixture();data.recurring=[{id:80,label:'Old subscription',amount:999,dayOfMonth:1,category:'Fun'}];
  const {context,page}=await setup(data);
  try{
    await page.reload();
    assert.deepEqual(await getData(page),data);
    await add(page);
    assert.deepEqual((await getData(page)).recurring,data.recurring);
    assert.deepEqual((await getData(page)).budgets,data.budgets);
    assert.deepEqual((await getData(page)).goals,data.goals);
  }finally{await context.close();}
});

test('mobile and laptop layouts have no horizontal overflow in light or dark mode',async()=>{
  const {context,page,errors}=await setup();
  try{
    for(const width of [320,375,390,768,1440]){
      await page.setViewportSize({width,height:844});
      for(const tab of ['overview','overall','add','entries']){
        await page.click(`[data-tab="${tab}"]`);
        const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
        assert.ok(dimensions.scroll<=dimensions.width,`${width}px ${tab}: ${JSON.stringify(dimensions)}`);
      }
    }
    await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:390,height:844});await page.click('[data-tab="overview"]');
    await page.evaluate(()=>scrollTo(0,0));
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await page.screenshot({path:path.join(root,'test-results','overview-mobile.png'),fullPage:true,animations:'disabled'});
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:path.join(root,'test-results','overview-desktop.png'),fullPage:true,animations:'disabled'});
    await page.click('[data-tab="overall"]');await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>{
      const svg=document.querySelector('#overallChart svg');
      return svg.getBoundingClientRect().width/svg.viewBox.baseVal.width>.95;
    });
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:path.join(root,'test-results','overall-mobile.png'),fullPage:true,animations:'disabled'});
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('Overall combines all months and category totals independent of the Overview month',async()=>{
  const {context,page,errors}=await setup();
  try{
    await page.click('[data-month="2026-08"]');
    await page.click('[data-tab="overall"]');
    assert.match(await page.locator('#overallSummary .value').innerText(),/₹3,246.3/);
    assert.match(await page.locator('#overallSummary').innerText(),/3[\s\S]*months with entries/);
    assert.match(await page.locator('#overallSummary').innerText(),/7[\s\S]*expenses recorded/);
    assert.match(await page.locator('#overallSummary').innerText(),/₹1,082.1[\s\S]*average per logged month/);
    assert.match(await page.locator('#overallCategories').innerText(),/Food[\s\S]*₹1,246.3/);
    assert.match(await page.locator('#overallCategories').innerText(),/Sports[\s\S]*₹2,000/);
    await page.locator('[data-overall-category="Food"]').click();
    assert.match(await page.locator('#overallCategories .cat-detail').innerText(),/₹1,246.3/);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('monthly and running-total graphs include missing months and support keyboard drill-down',async()=>{
  const {context,page,errors}=await setup();
  try{
    await page.click('[data-tab="overall"]');
    assert.equal(await page.locator('[data-chart-month]').count(),4);
    assert.match(await page.locator('[data-chart-month="2026-09"]').getAttribute('aria-label'),/₹0/);
    await page.click('[data-graph-mode="cumulative"]');
    assert.match(await page.locator('[data-chart-month="2026-08"]').getAttribute('aria-label'),/₹806 running total/);
    assert.match(await page.locator('[data-chart-month="2026-09"]').getAttribute('aria-label'),/₹806 running total/);
    assert.match(await page.locator('[data-chart-month="2026-10"]').getAttribute('aria-label'),/₹1,006 running total/);
    assert.match(await page.locator('[data-chart-month="2026-11"]').getAttribute('aria-label'),/₹3,246.3 running total/);
    await page.locator('[data-chart-month="2026-10"]').focus();
    await page.keyboard.press('Enter');
    assert.match(await page.locator('#overallChartDetail').innerText(),/October 2026 · ₹1,006/);
    await page.click('#openOverallMonth');
    assert.equal(await page.locator('#overviewMonthLabel').innerText(),'October 2026');
    assert.match(await page.locator('#overviewCards').innerText(),/₹200/);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('Overall empty state, tracking badges and the swap game handle zero and never alter expenses',async()=>{
  const {context,page,errors}=await setup({entries:[],nextId:1});
  try{
    const before=await getData(page);
    await page.click('[data-tab="overall"]');
    assert.equal(await page.locator('#overallSummary .value').innerText(),'₹0');
    assert.equal(await page.locator('.habit-badge.earned').count(),0);
    assert.match(await page.locator('#overallChart').innerText(),/first expense/);
    assert.ok(!(await page.locator('#tab-overall').innerText()).match(/NaN|Infinity|undefined/));
    await page.locator('#dailySwap').fill('100');
    assert.equal(await page.locator('#dailySwapValue').innerText(),'₹100');
    assert.match(await page.locator('#swapResult').innerText(),/₹3,000[\s\S]*₹36,500/);
    await page.locator('#dailySwap').fill('0');
    assert.match(await page.locator('#swapResult').innerText(),/₹0/);
    assert.deepEqual(await getData(page),before);
    await page.click('#overallLogBtn');await page.fill('#fAmount','125');await page.click('#submitBtn');
    await page.click('[data-tab="overall"]');
    assert.equal(await page.locator('.habit-badge.earned').count(),1);
    assert.match(await page.locator('#overallSummary .value').innerText(),/₹125/);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('tracking streaks use local dates across month boundaries and exclude future entries',async()=>{
  const data={entries:['2026-10-30','2026-10-31','2026-11-01','2026-11-22','2026-11-23','2026-11-24'].map((date,i)=>entry(i+1,date,10)),nextId:20};
  const {context,page,errors}=await setup(data);
  try{
    await page.click('[data-tab="overall"]');
    assert.match(await page.locator('#habitProgress').innerText(),/5 days journaled/);
    assert.match(await page.locator('#habitProgress').innerText(),/Current logging streak: 2 days · Best: 3 days/);
    await page.clock.setFixedTime(new Date('2026-11-27T06:30:00Z'));await page.reload();
    await page.click('[data-tab="overall"]');
    assert.match(await page.locator('#habitProgress').innerText(),/Current logging streak: 0 days/);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('Overall updates after changes and resets selections and data on profile switch',async()=>{
  const {context,page,errors}=await setup();
  try{
    await add(page,{amount:'50'});await page.click('[data-tab="overall"]');
    assert.equal(await page.locator('#overallSummary .value').innerText(),'₹3,296.3');
    await page.click('[data-graph-mode="cumulative"]');
    await page.locator('[data-overall-category="Sports"]').click();
    await page.click('#lockBtn');
    await page.click('[data-tab="overall"]');
    assert.equal(await page.locator('[data-graph-mode="monthly"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#overallSummary .value').innerText(),'₹4,629');
    assert.equal(await page.locator('[data-overall-category][aria-expanded="true"]').count(),0);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('Overall graph scrolls within mobile bounds across years and safely renders custom categories',async()=>{
  const label='<img src=x onerror="window.bad=1">';
  const data={entries:[entry(1,'2024-01-01',1234,label,'<script>bad()</script>'),entry(2,'2026-11-23',99)],nextId:3};
  const {context,page,errors}=await setup(data);
  try{
    await page.setViewportSize({width:320,height:844});await page.click('[data-tab="overall"]');
    assert.equal(await page.locator('[data-chart-month]').count(),35);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.equal(await page.locator('#tab-overall img,#tab-overall script').count(),0);
    await page.click('[data-graph-mode="cumulative"]');
    assert.match(await page.locator('[data-chart-month="2026-11"]').getAttribute('aria-label'),/₹1,333/);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('old service workers update automatically, preserve saved data/other caches, and work offline',async()=>{
  legacyMode=true;
  const {context,page,errors}=await setup(fixture(),{worker:true});
  try{
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.evaluate(()=>caches.open('another-app-cache'));
    legacyMode=false;
    await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();}).catch(error=>{
      // The previous page's controllerchange handler deliberately reloads during this call.
      if(!error.message.includes('Execution context was destroyed')) throw error;
    });
    await page.waitForSelector('#monthlyTotals');
    assert.deepEqual(await getData(page),fixture());
    assert.ok((await page.evaluate(()=>caches.keys())).includes('another-app-cache'));
    await context.setOffline(true);await page.goto(url+'/?offline-test=1');
    await add(page,{amount:'50.25'});
    assert.equal((await getData(page)).entries.at(-1).amount,50.25);
    await page.reload();
    assert.equal((await getData(page)).entries.length,8);
    assert.deepEqual(errors,[]);
  }finally{legacyMode=false;await context.close();}
});
