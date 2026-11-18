(function(){
'use strict';
const API=window.BOLTIV_API_BASE;
const ms=window.boltivMemoryStorage||window.localStorage;
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>'₦'+Number(v||0).toLocaleString('en-NG',{minimumFractionDigits:0,maximumFractionDigits:2});
const dt=v=>v?new Date(v).toLocaleDateString('en-NG',{day:'numeric',month:'short',year:'numeric'}):'—';
const ROLE={owner:'Owner',manager:'Manager',accountant:'Accountant',cashier:'Cashier',staff:'Staff'};
const STATES=["Abia","Adamawa","Akwa Ibom","Anambra","Bauchi","Bayelsa","Benue","Borno","Cross River","Delta","Ebonyi","Edo","Ekiti","Enugu","FCT","Gombe","Imo","Jigawa","Kaduna","Kano","Katsina","Kebbi","Kogi","Kwara","Lagos","Nasarawa","Niger","Ogun","Ondo","Osun","Oyo","Plateau","Rivers","Sokoto","Taraba","Yobe","Zamfara"];
const INDUSTRIES=["Retail / Provision store","Restaurant / Food","Pharmacy","Salon / Barbing","Fashion / Tailoring","Electronics / Phones","Building materials","Agriculture","Services / Consulting","Wholesale / Distribution","Other"];
const NAV=[['home','Home','<path d="m3.5 10.5 8.5-7 8.5 7v9a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1z"/><path d="M9.5 20.5v-6h5v6"/>'],
  ['sell','Sell','<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M3 4h2.5l2.2 11h10.6l2-8H7"/>'],
  ['sales','Sales','<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'],
  ['stock','Stock','<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>'],
  ['customers','Customers','<circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.6 3-6 7-6s7 2.4 7 6"/>'],
  ['branches','Branches','<path d="M3 21h18M5 21V8l7-4 7 4v13"/><path d="M9 21v-6h6v6"/>'],
  ['team','Team','<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.8c1.8.7 3 2.4 3 5.2"/>'],
  ['billing','Billing','<rect x="3" y="5.5" width="18" height="13" rx="2.6"/><path d="M3 10.2h18M7 15h3.2"/>'],
  ['activity','Activity','<path d="M4 12h4l2.5-6 3 12 2.5-6H20"/>'],
  ['more','More','<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>']];

let S={businesses:[],bizId:null,detail:null,tab:'home',plans:null,sub:null};

/* ---------- api ---------- */
async function api(path,opts){
  opts=opts||{};
  const h={'Accept':'application/json'};
  const tok=ms.getItem&&ms.getItem('boltivAuthToken'); if(tok)h.Authorization='Bearer '+tok;
  let body;
  if(opts.body!==undefined){h['Content-Type']='application/json';body=JSON.stringify(opts.body)}
  let r;try{r=await fetch(API+path,{method:opts.method||(body?'POST':'GET'),headers:h,body,cache:'no-store'})}catch(err){const ne=new Error('No connection. Check your internet and try again.');ne.network=true;throw ne}
  const d=await r.json().catch(()=>({success:false,message:'Unexpected response.'}));
  if(r.status===401){location.href='/login';throw new Error('auth')}
  if(!r.ok||d.success===false){const e=new Error(d.message||'Request failed.');e.data=d;e.status=r.status;throw e}
  return d;
}
function toast(m){const t=document.createElement('div');t.className='toast';t.textContent=m;document.body.appendChild(t);setTimeout(()=>t.remove(),3200)}
function can(p){return !!(S.detail&&S.detail.permissions.includes(p))}
function busy(btn,on,txt){if(!btn)return;btn.disabled=on;if(on){btn.dataset.t=btn.textContent;btn.textContent=txt||'Please wait…'}else if(btn.dataset.t)btn.textContent=btn.dataset.t}
function sheet(html){closeSheet();const m=document.createElement('div');m.className='modal';m.innerHTML='<div class="sheet" role="dialog" aria-modal="true">'+html+'</div>';m.addEventListener('click',e=>{if(e.target===m)closeSheet()});$('#layer').appendChild(m);return m}
function closeSheet(){$('#layer').innerHTML=''}

/* ---------- shell ---------- */
function renderNav(){
  const ready=!!(S.bizId&&S.detail);
  const icon=p=>'<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">'+p+'</svg>';
  const side=ready?NAV.filter(n=>n[0]!=='more'&&tabOk(n[0])):[];
  $('#sideNav').innerHTML=side.map(n=>'<a class="nv'+(S.tab===n[0]?' on':'')+'" data-tab="'+n[0]+'">'+icon(n[2])+n[1]+'</a>').join('');
  const bt=ready?barTabs().concat(['more']):[],bar=$('#bar');bar.hidden=!bt.length;
  bar.innerHTML=bt.map(id=>{const n=NAV.find(x=>x[0]===id),on=id==='more'?!barTabs().includes(S.tab):S.tab===id;return '<a class="'+(on?'on':'')+'" data-tab="'+id+'">'+icon(n[2])+'<span>'+n[1]+'</span></a>'}).join('');
  const sw=$('#switcher');
  if(S.businesses.length){sw.hidden=false;sw.innerHTML=S.businesses.map(b=>'<option value="'+b.id+'"'+(b.id===S.bizId?' selected':'')+'>'+esc(b.name)+'</option>').join('')+'<option value="new">+ New business</option>'}else sw.hidden=true;
  $('#title').textContent=ready&&S.tab!=='home'?NAV.find(n=>n[0]===S.tab)[1]:'Business Manager';
}
document.addEventListener('click',e=>{
  const t=e.target.closest('[data-tab]');if(t){S.tab=t.dataset.tab;render();window.scrollTo(0,0);return}
  const a=e.target.closest('[data-act]');if(a&&actions[a.dataset.act])actions[a.dataset.act](a,e);
});
$('#switcher').addEventListener('change',async e=>{
  if(e.target.value==='new'){S.bizId=null;S.detail=null;S.tab='home';renderOnboarding();renderNav();return}
  await selectBiz(Number(e.target.value));
});

/* ---------- loading ---------- */
async function boot(){
  try{
    const d=await api('/api/business/mine');S.businesses=d.businesses;
    const saved=Number(ms.getItem('boltivBizId')||0);
    const pick=S.businesses.find(b=>b.id===saved)||S.businesses[0];
    if(pick)await selectBiz(pick.id);else{renderNav();renderOnboarding()}
  }catch(e){if(e.message!=='auth')$('#view').innerHTML='<div class="card empty">'+esc(e.message)+'<br><br><button class="btn" data-act="retry">Try again</button></div>'}
}
async function selectBiz(id){
  if(P.biz!==id)P=freshPOS(id);S.bizId=id;ms.setItem('boltivBizId',String(id));S.sub=null;
  try{S.detail=await api('/api/business/detail?business_id='+id)}catch(e){toast(e.message);S.bizId=null;return}
  render();syncQueue();
}
function render(){if(!tabOk(S.tab))S.tab='home';renderNav();({home:renderHome,sell:renderSell,sales:renderSales,stock:renderStock,customers:renderCustomers,more:renderMore,branches:renderBranches,team:renderTeam,billing:renderBilling,activity:renderActivity}[S.tab]||EXT.tabs[S.tab]||renderHome)()}

/* ---------- onboarding ---------- */
async function renderOnboarding(){
  $('#view').innerHTML='<div class="card"><h2>Register your business</h2><div class="mut">Set up your business profile in a minute. You can add branches and your team afterwards.</div>'+
  '<label>BUSINESS NAME</label><input id="f_name" maxlength="80" placeholder="e.g. Ade &amp; Sons Stores">'+
  '<label>TYPE OF BUSINESS</label><select class="f" id="f_industry">'+INDUSTRIES.map(i=>'<option>'+esc(i)+'</option>').join('')+'</select>'+
  '<label>STATE</label><select class="f" id="f_state"><option value="">Select state</option>'+STATES.map(s=>'<option>'+s+'</option>').join('')+'</select>'+
  '<label>PHONE</label><input id="f_phone" inputmode="tel" maxlength="20" placeholder="0801 234 5678">'+
  '<label>BUSINESS EMAIL (OPTIONAL)</label><input id="f_email" type="email" maxlength="120">'+
  '<label>ADDRESS (OPTIONAL)</label><input id="f_address" maxlength="200">'+
  '<label>TIN (OPTIONAL)</label><input id="f_tin" maxlength="20" placeholder="Tax identification number">'+
  '<br><button class="btn block" data-act="createBiz">Create business</button></div><div id="planPreview"></div>';
  try{const p=await getPlans();$('#planPreview').innerHTML='<div class="card"><h2>Plans</h2><div class="mut">Pick a plan after creating your business. Pay from your BOLTIV wallet.</div><div class="plans" style="margin-top:12px">'+p.plans.map(planCard).join('')+'</div></div>'}catch(e){}
}
async function getPlans(){if(!S.plans)S.plans=await api('/api/business/plans');return S.plans}
function feat(p){
  const f=p.features||{},l=[];
  l.push(p.maxBranches<0?'Unlimited branches':p.maxBranches+(p.maxBranches===1?' branch':' branches'));
  l.push(p.maxMembers<0?'Unlimited team members':'Up to '+p.maxMembers+' team members');
  l.push(f.advanced_inventory?'Advanced inventory':'Basic inventory');
  l.push(f.reports==='full'?'Full reports & analytics':'Basic reports');
  if(f.appointments)l.push('Appointments');
  if(f.audit_export)l.push('Audit log export');
  return l;
}
function planCard(p,sel){return '<div class="plan'+(sel?' sel':'')+'" data-act="pickPlan" data-key="'+esc(p.key)+'"><h3>'+esc(p.name)+'</h3><div class="mut">'+esc(p.tagline||'')+'</div><div class="pr">'+money(p.priceMonthly)+'<small class="mut"> /month</small></div><ul>'+feat(p).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul></div>'}

/* ---------- home ---------- */
function banner(sub){
  const s=sub||{state:'none'};
  const go='<button class="btn sm" data-tab="billing">'+(s.state==='none'?'Choose plan':'Renew')+'</button>';
  const map={
    none:['warn','Choose a plan to start using your business tools.',go],
    trial:['ok','Free trial: '+s.daysLeft+' day'+(s.daysLeft===1?'':'s')+' left on '+esc(s.planName)+'.',go],
    active:[s.daysLeft<=7?'warn':'ok',esc(s.planName)+' plan active until '+dt(s.expiresAt)+' ('+s.daysLeft+' days left).',s.daysLeft<=7?go:''],
    grace:['warn','Subscription ended. Renew by '+dt(s.graceEndsAt)+' to keep editing.',go],
    expired:['bad','Subscription expired. Your data is safe but read-only until you renew.',go],
    suspended:['bad','Subscription suspended. Contact BOLTIV support.','']
  };
  const m=map[s.state]||map.none;
  return '<div class="banner '+m[0]+'"><div class="grow">'+m[1]+'</div>'+m[2]+'</div>';
}
function lim(n){return n<0?'∞':n}
function renderHome(){
  const d=S.detail,b=d.business,u=d.usage,sub=d.subscription,lm=sub.limits||{};
  $('#view').innerHTML=banner(sub)+
  '<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>'+esc(b.name)+'</h2><div class="mut">'+esc([b.industry,b.state].filter(Boolean).join(' · ')||'Business profile')+'</div></div><span class="pill gold">'+esc(ROLE[d.role])+'</span></div>'+
  '<div class="grid g2" style="margin-top:10px"><div class="stat"><span class="mut">Branches</span><b>'+u.branches+' / '+lim(lm.branches??1)+'</b></div><div class="stat"><span class="mut">Team members</span><b>'+u.members+' / '+lim(lm.members??1)+'</b></div></div>'+
  (can('business.edit')?'<br><button class="btn ghost sm" data-act="editBiz">Edit business details</button>':'')+'</div>'+
  '<div class="card"><h2>Business details</h2>'+[['Phone',b.phone],['Email',b.email],['Address',b.address],['TIN',b.tin],['Currency',b.currency]].map(r=>'<div class="row"><div class="mut" style="width:90px">'+r[0]+'</div><div class="grow">'+esc(r[1]||'—')+'</div></div>').join('')+'</div>'+
  '<div id="homeToday"></div><div class="card"><h2>Coming next</h2><div class="mut">Staff, appointments and reports &amp; analytics are being added next.</div></div>';
  homeExtras();
}

/* ---------- branches ---------- */
function renderBranches(){
  const d=S.detail;
  $('#view').innerHTML=banner(d.subscription)+'<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Branches</h2><div class="mut">'+d.usage.branches+' of '+lim((d.subscription.limits||{}).branches??1)+' used</div></div>'+(can('branches.manage')?'<button class="btn sm" data-act="branchForm">Add branch</button>':'')+'</div>'+
  d.branches.map(x=>'<div class="row"><div class="grow"><div class="nm">'+esc(x.name)+(x.isMain?' <span class="pill gold">MAIN</span>':'')+'</div><div class="mut">'+esc([x.address,x.phone].filter(Boolean).join(' · ')||'No address yet')+'</div></div>'+
  (x.status!=='active'?'<span class="pill bad">Inactive</span>':'')+(can('branches.manage')?'<button class="btn ghost sm" data-act="branchForm" data-id="'+x.id+'">Edit</button>':'')+'</div>').join('')+'</div>';
}

/* ---------- team ---------- */
async function renderTeam(){
  $('#view').innerHTML='<div class="empty"><span class="spin"></span></div>';
  try{
    const d=await api('/api/business/members?business_id='+S.bizId);S.team=d;
    $('#view').innerHTML=banner(S.detail.subscription)+'<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Team</h2><div class="mut">'+d.members.filter(m=>m.status==='active').length+' of '+lim((S.detail.subscription.limits||{}).members??1)+' seats used</div></div>'+(d.canManage?'<button class="btn sm" data-act="memberForm">Add person</button>':'')+'</div>'+
    d.members.map(m=>{const manageable=d.canManage&&m.role!=='owner'&&d.assignableRoles.includes(m.role);
      return '<div class="row"><div class="grow"><div class="nm">'+esc(m.name||m.email||'Member')+(m.isYou?' (you)':'')+'</div><div class="mut">'+esc(m.email||'')+' · '+(m.branchIds?m.branchIds.length+' branch'+(m.branchIds.length>1?'es':''):'All branches')+'</div></div><span class="pill '+(m.status==='active'?'gold':'bad')+'">'+esc(ROLE[m.role])+(m.status!=='active'?' · off':'')+'</span>'+(manageable?'<button class="btn ghost sm" data-act="memberForm" data-id="'+m.id+'">Edit</button>':'')+'</div>'}).join('')+'</div>'+
    '<div class="card"><h2>Roles</h2><div class="mut"><b>Owner</b> full control · <b>Manager</b> runs the business, no billing · <b>Accountant</b> finance and reports · <b>Cashier</b> sales and customers · <b>Staff</b> limited access.</div></div>';
  }catch(e){$('#view').innerHTML='<div class="card empty">'+esc(e.message)+'</div>'}
}

/* ---------- billing ---------- */
const B={planKey:null,months:12,quote:null,idem:null};
async function renderBilling(){
  $('#view').innerHTML='<div class="empty"><span class="spin"></span></div>';
  try{
    const [sd,pl]=await Promise.all([api('/api/business/subscription?business_id='+S.bizId),getPlans()]);S.sub=sd;
    const sub=sd.subscription;
    if(!B.planKey)B.planKey=sub.planKey||(pl.plans[1]||pl.plans[0]).key;
    $('#view').innerHTML=banner(sub)+
    (sd.canPay?'<div class="card"><h2>'+(sub.state==='none'?'Choose a plan':'Renew or change plan')+'</h2><div class="mut">Paid from your BOLTIV wallet. Longer periods cost less.</div>'+
      '<div class="seg" id="seg">'+[1,6,12].map(m=>'<button data-act="period" data-m="'+m+'" class="'+(B.months===m?'on':'')+'">'+(m===12?'12 months':m+' month'+(m>1?'s':''))+(pl.discounts[m]?'<small>Save '+pl.discounts[m]+'%</small>':'')+'</button>').join('')+'</div>'+
      '<div class="plans" id="planList">'+pl.plans.map(p=>planCard(p,p.key===B.planKey)).join('')+'</div><div id="quoteBox"></div></div>':
      '<div class="card"><div class="mut">Only the business owner can pay or change the plan.</div></div>')+
    '<div class="card"><h2>Payment history</h2>'+(sd.payments.length?sd.payments.map(p=>'<div class="row"><div class="grow"><div class="nm">'+esc((pl.plans.find(x=>x.key===p.planKey)||{name:p.planKey}).name)+' · '+p.months+' mo</div><div class="mut">'+dt(p.createdAt)+' · until '+dt(p.expiresAt)+(p.discountAmount?' · saved '+money(p.discountAmount):'')+'</div></div><b>'+money(p.amount)+'</b></div>').join(''):'<div class="empty">No payments yet.</div>')+'</div>';
    if(sd.canPay)loadQuote();
  }catch(e){$('#view').innerHTML='<div class="card empty">'+esc(e.message)+'</div>'}
}
async function loadQuote(){
  const box=$('#quoteBox');if(!box)return;B.idem=null;box.innerHTML='<div class="empty"><span class="spin"></span></div>';
  try{
    const d=await api('/api/business/subscription/quote',{body:{businessId:S.bizId,planKey:B.planKey,months:B.months}});B.quote=d;const q=d.quote;
    box.innerHTML='<div class="sum"><div><span>'+B.months+' month'+(B.months>1?'s':'')+' × '+money(q.listAmount/B.months)+'</span><span>'+money(q.listAmount)+'</span></div>'+
    (q.discountAmount?'<div style="color:var(--ok)"><span>Discount ('+q.discountPct+'%)</span><span>−'+money(q.discountAmount)+'</span></div>':'')+
    (q.creditAmount?'<div style="color:var(--ok)"><span>Unused time on current plan</span><span>−'+money(q.creditAmount)+'</span></div>':'')+
    '<div class="tot"><span>Total</span><span>'+money(q.amount)+'</span></div><div><span class="mut">Wallet balance</span><span class="'+(d.sufficient?'':'mut')+'">'+money(d.walletBalance)+'</span></div></div>'+
    (q.mode==='extend'?'<div class="mut" style="margin-top:8px">This adds time to your current plan.</div>':'')+
    (d.blockedReason?'<div class="banner bad" style="margin-top:12px">'+esc(d.blockedReason)+'</div>':'')+
    '<br>'+(d.sufficient?'<button class="btn block" data-act="pay"'+(d.blockedReason?' disabled':'')+'>Pay '+money(q.amount)+' from wallet</button>':'<a class="btn block" style="display:block;text-align:center;text-decoration:none" href="/wallet">Fund wallet (need '+money(q.amount-d.walletBalance)+' more)</a>');
  }catch(e){box.innerHTML='<div class="banner bad">'+esc(e.message)+'</div>'}
}

/* ---------- activity ---------- */
async function renderActivity(){
  if(!can('audit.view')){$('#view').innerHTML='<div class="card empty">Your role cannot view the activity log.</div>';return}
  $('#view').innerHTML='<div class="empty"><span class="spin"></span></div>';
  try{
    const d=await api('/api/business/audit?business_id='+S.bizId+'&limit=50');
    S.audit=d.logs;$('#view').innerHTML='<div class="card"><div class="row" style="border:0;padding:0"><div class="grow"><h2>Activity log</h2></div>'+(planFeat('audit_export')?'<button class="btn ghost sm" data-act="auditExport">Export CSV</button>':'')+'</div><div class="mut">Every change to your business is recorded here.</div>'+(d.logs.length?d.logs.map(l=>'<div class="log"><b>'+esc(l.action.replace(/[._]/g,' '))+'</b> <span class="mut">by '+esc(l.actor||'—')+' · '+new Date(l.at).toLocaleString('en-NG',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+'</span></div>').join(''):'<div class="empty">Nothing yet.</div>')+'</div>';
  }catch(e){$('#view').innerHTML='<div class="card empty">'+esc(e.message)+'</div>'}
}

/* ---------- phase 2: sell, sales, stock, customers ---------- */
const m2=v=>'₦'+Number(v||0).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2});
const num=v=>Number(v)||0;
const uidk=()=>(window.crypto&&crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2));
const todayStr=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
const debounce=(fn,ms)=>{let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}};
const activeBranches=()=>S.detail.branches.filter(b=>b.status==='active');
const planFeat=k=>{const f=(S.detail&&S.detail.subscription&&S.detail.subscription.features)||{};return f[k]};
const freshPOS=biz=>({biz:biz||null,branchId:null,cart:[],customer:null,discount:'',pay:{cash:'',transfer:'',pos:''},idem:null,search:'',products:[],apptId:null});
let P=freshPOS(),ST={search:'',low:false,branchId:'',list:[]},CU={search:'',owing:false,list:[]},SL={date:todayStr()};
function branchSel(id,cur,all){const bs=activeBranches();if(bs.length<2)return '';return '<select class="f" id="'+id+'" style="margin-bottom:10px">'+(all?'<option value="">All branches</option>':'')+bs.map(b=>'<option value="'+b.id+'"'+(String(b.id)===String(cur)?' selected':'')+'>'+esc(b.name)+'</option>').join('')+'</select>'}
const PERM_OF={sell:'sales.create',sales:'sales.view',stock:'inventory.view',customers:'customers.view',team:'members.view',billing:'billing.view',activity:'audit.view'};
const tabOk=id=>id==='home'||id==='branches'||id==='more'||can(PERM_OF[id]);
function barTabs(){return ['home','sell','stock','customers','appointments','finance','invoices','expenses','reports'].filter(n=>NAV.some(x=>x[0]===n)&&tabOk(n)).slice(0,4)}
function renderMore(){
  const inBar=barTabs();const rest=NAV.filter(n=>n[0]!=='more'&&!inBar.includes(n[0])&&tabOk(n[0]));
  $('#view').innerHTML='<div class="card">'+rest.map(n=>'<a class="row" data-tab="'+n[0]+'" style="text-decoration:none;cursor:pointer"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true">'+n[2]+'</svg><div class="grow nm">'+n[1]+'</div><span class="mut">›</span></a>').join('')+'</div><div class="card"><a class="row" href="/dashboard" style="text-decoration:none;border:0"><div class="grow nm">← Back to BOLTIV</div></a></div>';
}

/* ----- offline queue (sales made without a connection) ----- */
const memQ={};
const Q={key:()=>'bmq:'+S.bizId,
  load(){try{return JSON.parse(localStorage.getItem(Q.key())||'[]')}catch(e){return memQ[Q.key()]||[]}},
  save(a){try{localStorage.setItem(Q.key(),JSON.stringify(a))}catch(e){memQ[Q.key()]=a}}};
function queueSale(body){const a=Q.load();a.push({body,at:Date.now()});Q.save(a);resetCart();toast('No connection. Sale saved on this device and will sync automatically.');renderPending()}
let syncing=false;
async function syncQueue(){
  if(syncing||!S.bizId)return;const a=Q.load().filter(x=>!x.error);if(!a.length){renderPending();return}
  syncing=true;let ok=0;
  try{
    for(const it of Q.load()){
      if(it.error)continue;
      try{await api('/api/business/sales/create',{body:it.body});Q.save(Q.load().filter(x=>x.body.idempotencyKey!==it.body.idempotencyKey));ok++}
      catch(e){if(!e.status)break;if(e.status>=400&&e.status<500){const all=Q.load();const f=all.find(x=>x.body.idempotencyKey===it.body.idempotencyKey);if(f){f.error=e.message;Q.save(all)}}else break}
    }
  }finally{syncing=false}
  if(ok)toast(ok+' offline sale'+(ok>1?'s':'')+' synced');renderPending();
}
function renderPending(){
  const box=$('#pendBox');if(!box)return;const a=Q.load();
  const wait=a.filter(x=>!x.error).length,bad=a.filter(x=>x.error);
  box.innerHTML=(wait?'<div class="banner warn"><div class="grow">'+wait+' sale'+(wait>1?'s':'')+' waiting to sync. They will upload when you are back online.</div><button class="btn sm" data-act="syncNow">Sync now</button></div>':'')+
    bad.map(x=>'<div class="banner bad"><div class="grow">A saved sale could not be recorded: '+esc(x.error)+'</div><button class="btn sm ghost" data-act="discardQ" data-k="'+esc(x.body.idempotencyKey)+'">Discard</button></div>').join('');
}
window.addEventListener('online',()=>syncQueue());setInterval(()=>syncQueue(),30000);

/* ----- Sell (POS) ----- */
async function renderSell(){
  const bs=activeBranches();
  if(!bs.length){$('#view').innerHTML='<div class="card empty">Add a branch first.</div>';return}
  if(!bs.find(b=>b.id===P.branchId))P.branchId=bs[0].id;
  $('#view').innerHTML=banner(S.detail.subscription)+'<div id="pendBox"></div><div class="pos"><div class="card" style="margin:0">'+branchSel('p_branch',P.branchId)+'<input id="p_search" placeholder="Search item or scan barcode" value="'+esc(P.search)+'" autocomplete="off" enterkeyhint="search"><div id="prodGrid" style="margin-top:10px"><div class="empty"><span class="spin"></span></div></div></div><div id="cartPanel"></div></div><div class="cartbar" id="cartBar"></div>';
  renderPending();renderCartPanel();loadPosProducts();
}
async function loadPosProducts(){
  try{const d=await api('/api/business/products?business_id='+S.bizId+'&branch_id='+P.branchId+'&limit=60&search='+encodeURIComponent(P.search));P.products=d.products;drawProducts()}
  catch(e){const g=$('#prodGrid');if(g)g.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
}
function drawProducts(){
  const g=$('#prodGrid');if(!g)return;
  g.innerHTML=P.products.length?P.products.map(p=>{const o=p.trackStock&&p.stock<=0;return '<button class="pitem" data-act="addItem" data-id="'+p.id+'"'+(o?' disabled':'')+'><span class="pn">'+esc(p.name)+'</span><span class="pp">'+money(p.sellPrice)+'</span><span class="ps'+(o?' bad':p.low?' warn':'')+'">'+(p.trackStock?(o?'Out of stock':p.stock+' '+esc(p.unit)):'')+'</span></button>'}).join(''):'<div class="empty">No items found.'+(can('inventory.manage')?'<br><br><button class="btn sm" data-act="productForm">Add a product</button>':'')+'</div>';
}
function addToCart(p){
  const l=P.cart.find(x=>x.productId===p.id),q=(l?l.qty:0)+1;
  if(p.trackStock&&q>p.stock){toast('Only '+p.stock+' '+p.unit+' in stock');return}
  if(l)l.qty=q;else P.cart.push({productId:p.id,name:p.name,price:p.sellPrice,qty:1,tracked:p.trackStock,stock:p.stock,unit:p.unit});
  P.idem=P.idem||uidk();renderCartPanel();
}
function calcCart(){
  const b=S.detail.business,rate=b.vatRate||0,inc=b.vatInclusive;let sub=0;
  P.cart.forEach(l=>{sub+=Math.round(Math.round(l.price*100)*num(l.qty))});
  const disc=Math.min(sub,Math.max(0,Math.round(num(P.discount)*100))),taxable=sub-disc;let tax=0,total=taxable;
  if(rate>0){if(inc)tax=taxable-Math.round(taxable/(1+rate/100));else{tax=Math.round(taxable*rate/100);total=taxable+tax}}
  return {sub,disc,tax,total,rate,inc};
}
function renderCartPanel(){
  const el=$('#cartPanel');if(!el)return;
  const cust=P.customer;
  el.innerHTML='<div class="card" id="cartCard" style="margin:0"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Cart</h2></div>'+(can('pos.custom_item')?'<button class="btn ghost sm" data-act="customItem">+ Custom item</button>':'')+(P.cart.length?'<button class="btn ghost sm" data-act="clearCart" style="margin-left:6px">Clear</button>':'')+'</div>'+
  (P.cart.length?P.cart.map((l,i)=>'<div class="row"><div class="grow"><div class="nm">'+esc(l.name)+'</div><div class="mut">'+money(l.price)+(l.tracked?' · '+l.stock+' in stock':'')+'</div></div><div class="qty"><button data-act="qty" data-i="'+i+'" data-d="-1" aria-label="Less">−</button><input data-in="qty" data-i="'+i+'" value="'+l.qty+'" inputmode="decimal" aria-label="Quantity"><button data-act="qty" data-i="'+i+'" data-d="1" aria-label="More">+</button></div><b id="lt_'+i+'" style="min-width:72px;text-align:right"></b><button class="x" data-act="rm" data-i="'+i+'" aria-label="Remove">✕</button></div>').join(''):'<div class="empty">Tap items to add them.</div>')+
  (P.cart.length?'<div style="margin-top:10px">'+(cust?'<div class="row"><div class="grow"><div class="nm">'+esc(cust.name)+'</div>'+(cust.balance>0?'<div class="mut">Owes '+money(cust.balance)+'</div>':'')+'</div><button class="btn ghost sm" data-act="pickCustomer">Change</button><button class="x" data-act="noCustomer" aria-label="Remove customer">✕</button></div>':'<button class="btn ghost sm block" data-act="pickCustomer">+ Add customer (optional)</button>')+
  (can('pos.discount')?'<label>DISCOUNT (₦)</label><input data-in="disc" inputmode="decimal" value="'+esc(P.discount)+'" placeholder="0">':'')+
  '<label>PAYMENT RECEIVED</label><div class="pay3"><div><span class="mut">Cash</span><input data-in="pay" data-m="cash" inputmode="decimal" value="'+esc(P.pay.cash)+'" placeholder="0"></div><div><span class="mut">Transfer</span><input data-in="pay" data-m="transfer" inputmode="decimal" value="'+esc(P.pay.transfer)+'" placeholder="0"></div><div><span class="mut">POS</span><input data-in="pay" data-m="pos" inputmode="decimal" value="'+esc(P.pay.pos)+'" placeholder="0"></div></div><button class="btn ghost sm" data-act="exact" style="margin-top:8px">Exact cash</button><div class="sum" id="totBox"></div><br><button class="btn block" id="completeBtn" data-act="complete">Complete sale</button></div>':'')+'</div>';
  updateTotals();watchCart();
}
function updateTotals(){
  const t=calcCart(),box=$('#totBox');
  P.cart.forEach((l,i)=>{const e=$('#lt_'+i);if(e)e.textContent=money(Math.round(Math.round(l.price*100)*num(l.qty))/100)});
  const count=P.cart.reduce((a,l)=>a+num(l.qty),0),bar=$('#cartBar');
  if(bar)bar.innerHTML=P.cart.length?'<button class="btn block" data-act="toCart">View cart · '+count+' item'+(count===1?'':'s')+' · '+m2(t.total/100)+'</button>':'';
  if(!box)return;
  const cash=Math.round(num(P.pay.cash)*100),recv=cash+Math.round((num(P.pay.transfer)+num(P.pay.pos))*100),change=Math.max(0,recv-t.total),due=Math.max(0,t.total-recv);
  box.innerHTML='<div><span>Subtotal</span><span>'+m2((t.sub)/100)+'</span></div>'+(t.disc?'<div style="color:var(--ok)"><span>Discount</span><span>−'+m2(t.disc/100)+'</span></div>':'')+(t.rate>0?'<div><span>VAT '+t.rate+'%'+(t.inc?' (included)':'')+'</span><span>'+m2(t.tax/100)+'</span></div>':'')+
    '<div class="tot"><span>Total</span><span>'+m2(t.total/100)+'</span></div><div><span class="mut">Received</span><span>'+m2(recv/100)+'</span></div>'+
    (change>0?'<div><span class="mut">Change</span><b>'+m2(change/100)+'</b></div>':'')+(due>0?'<div style="color:var(--warn)"><span>'+(P.customer?'Balance (on credit)':'Still to pay')+'</span><b>'+m2(due/100)+'</b></div>':'');
  const btn=$('#completeBtn');if(btn){const why=!S.detail.subscription.writable?'Subscription inactive':(due>0&&!P.customer)?'Add a customer or collect full amount':change>cash?'Change must come from cash':'';btn.disabled=!!why||!P.cart.length;btn.textContent=why||'Complete sale · '+m2(t.total/100)}
}
let cartObs;
function watchCart(){
  if(cartObs)cartObs.disconnect();const c=$('#cartCard'),b=$('#cartBar');
  if(!c||!b||!window.IntersectionObserver)return;
  cartObs=new IntersectionObserver(es=>{b.style.display=es[0].isIntersecting?'none':''},{threshold:0.15});cartObs.observe(c);
}
function resetCart(){P.cart=[];P.customer=null;P.discount='';P.pay={cash:'',transfer:'',pos:''};P.idem=null;P.apptId=null;renderCartPanel()}

/* ----- receipts ----- */
const RCSS='body{font:12px/1.4 "Courier New",monospace;color:#000;margin:0}.c{text-align:center}.b{font-weight:700}.r{display:flex;justify-content:space-between;gap:8px}hr{border:0;border-top:1px dashed #000;margin:6px 0}.it{margin:3px 0}';
function receiptHtml(s,h){
  const o=[];o.push('<div class="c b" style="font-size:14px">'+esc(h.name)+'</div>');
  [h.address,h.phone,h.tin?'TIN: '+h.tin:''].filter(Boolean).forEach(x=>o.push('<div class="c">'+esc(x)+'</div>'));
  o.push('<hr><div class="r"><span>'+esc(s.receiptNo)+'</span><span>'+new Date(s.createdAt).toLocaleString('en-NG',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})+'</span></div>');
  o.push('<div>Branch: '+esc(s.branchName)+'</div>');if(s.cashier)o.push('<div>Served by: '+esc(s.cashier)+'</div>');if(s.customerName)o.push('<div>Customer: '+esc(s.customerName)+'</div>');
  if(s.status==='void')o.push('<div class="c b">*** VOIDED ***</div>');
  o.push('<hr>');s.items.forEach(i=>o.push('<div class="it"><div>'+esc(i.name)+'</div><div class="r"><span>'+i.qty+' x '+m2(i.unitPrice)+'</span><span>'+m2(i.lineTotal)+'</span></div></div>'));o.push('<hr>');
  o.push('<div class="r"><span>Subtotal</span><span>'+m2(s.subtotal)+'</span></div>');
  if(s.discount>0)o.push('<div class="r"><span>Discount</span><span>-'+m2(s.discount)+'</span></div>');
  if(s.vatRate>0)o.push('<div class="r"><span>VAT '+s.vatRate+'%'+(s.vatInclusive?' (incl.)':'')+'</span><span>'+m2(s.tax)+'</span></div>');
  o.push('<div class="r b" style="font-size:14px"><span>TOTAL</span><span>'+m2(s.total)+'</span></div><hr>');
  s.payments.forEach(p=>o.push('<div class="r"><span>Paid ('+esc(p.method)+')</span><span>'+m2(p.amount)+'</span></div>'));
  if(s.change>0)o.push('<div class="r"><span>Change</span><span>'+m2(s.change)+'</span></div>');
  if(s.balanceDue>0)o.push('<div class="r b"><span>Balance owed</span><span>'+m2(s.balanceDue)+'</span></div>');
  o.push('<hr><div class="c">'+esc(h.footer||'Thank you for your patronage!')+'</div><div class="c" style="margin-top:4px;font-size:10px">Powered by BOLTIV</div>');
  return o.join('');
}
function receiptText(s,h){
  const l=[h.name,s.receiptNo+' · '+new Date(s.createdAt).toLocaleString('en-NG'),''];
  s.items.forEach(i=>l.push(i.qty+' x '+i.name+'  '+m2(i.lineTotal)));
  l.push('');if(s.discount>0)l.push('Discount: -'+m2(s.discount));if(s.vatRate>0)l.push('VAT '+s.vatRate+'%: '+m2(s.tax));
  l.push('TOTAL: '+m2(s.total));if(s.balanceDue>0)l.push('Balance owed: '+m2(s.balanceDue));l.push('',h.footer||'Thank you for your patronage!');return l.join('\n');
}
function waPhone(p){const d=String(p||'').replace(/\D/g,'');return d.startsWith('234')&&d.length===13?d:d.startsWith('0')&&d.length===11?'234'+d.slice(1):''}
function showReceipt(s,h,opts){
  opts=opts||{};S.last={s,h};
  sheet('<h2>'+esc(s.receiptNo)+(s.status==='void'?' · Voided':'')+'</h2><div class="docprev" id="docPrev">'+(window.BDOC?BDOC.WAIT:'')+'</div>'+
    '<div class="grid g2"><button class="btn" data-act="shareDoc">Share on WhatsApp</button><button class="btn ghost" data-act="saveDoc">Save picture</button></div>'+
    '<div class="grid g2" style="margin-top:10px"><button class="btn ghost" data-act="printRcpt" data-w="80">Print 80mm</button><button class="btn ghost" data-act="printRcpt" data-w="58">Print 58mm</button></div>'+
    '<button class="btn ghost block" style="margin-top:10px" data-act="close">'+(opts.history?'Close':'New sale')+'</button>'+
    (opts.canVoid&&s.status==='completed'?'<br><button class="btn bad block" data-act="voidSale" data-id="'+s.id+'">Void this sale</button>':''));
  if(window.BDOC)BDOC.mount('receipt',s,h,{name:'Receipt-'+String(s.receiptNo||'sale').replace(/[^\w.-]+/g,'-')+'.png',text:h.name+'\nReceipt '+s.receiptNo+' · Total '+m2(s.total)+(s.balanceDue>0?'\nBalance owed: '+m2(s.balanceDue):'')+'\n\n'+(h.footer||'Thank you for your patronage!'),phone:waPhone(s.customerPhone)});
}
function printReceipt(w){
  if(!S.last)return;const f=document.createElement('iframe');f.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0';document.body.appendChild(f);
  const d=f.contentWindow.document;d.open();d.write('<!doctype html><html><head><meta charset="utf-8"><title>Receipt</title><style>@page{margin:2mm;size:'+w+'mm auto}'+RCSS+'body{width:'+(w-6)+'mm}</style></head><body>'+receiptHtml(S.last.s,S.last.h)+'</body></html>');d.close();
  setTimeout(()=>{try{f.contentWindow.focus();f.contentWindow.print()}catch(e){}setTimeout(()=>f.remove(),2000)},250);
}

/* ----- Sales history ----- */
async function renderSales(){
  $('#view').innerHTML='<div class="card"><div class="row" style="border:0;padding:0"><div class="grow"><h2>Sales</h2></div><input type="date" id="sl_date" value="'+SL.date+'" max="'+todayStr()+'" style="width:auto;margin:0"></div><div id="slSum" style="margin-top:12px"></div></div><div class="card"><input id="sl_search" placeholder="Search receipt or customer"><div id="slList" style="margin-top:8px"><div class="empty"><span class="spin"></span></div></div></div>';
  loadSales();
}
async function loadSales(){
  const se=$('#sl_search'),q=encodeURIComponent(se?se.value:'');
  try{
    const [sm,ls]=await Promise.all([api('/api/business/sales/summary?business_id='+S.bizId+'&date='+SL.date),api('/api/business/sales?business_id='+S.bizId+'&from='+SL.date+'&to='+SL.date+'&limit=100&search='+q)]);
    const meth=Object.entries(sm.byMethod).map(([k,v])=>'<div class="row" style="padding:6px 0"><div class="grow mut" style="text-transform:capitalize">'+esc(k)+'</div><b>'+m2(v)+'</b></div>').join('');
    $('#slSum').innerHTML='<div class="grid g2"><div class="stat"><span class="mut">Sales</span><b>'+sm.count+'</b></div><div class="stat"><span class="mut">Total</span><b>'+m2(sm.total)+'</b></div></div>'+(sm.credit>0?'<div class="mut" style="margin-top:8px">On credit: '+m2(sm.credit)+'</div>':'')+(meth?'<div style="margin-top:8px">'+meth+'</div>':'')+(sm.voided?'<div class="mut">'+sm.voided+' voided</div>':'');
    $('#slList').innerHTML=ls.sales.length?ls.sales.map(s=>'<div class="row" data-act="viewSale" data-id="'+s.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(s.receiptNo)+(s.status==='void'?' <span class="pill bad">VOID</span>':'')+'</div><div class="mut">'+new Date(s.at).toLocaleTimeString('en-NG',{hour:'2-digit',minute:'2-digit'})+' · '+esc(s.customer||s.cashier||'')+(s.balanceDue>0?' · owes '+money(s.balanceDue):'')+'</div></div><b>'+m2(s.total)+'</b></div>').join(''):'<div class="empty">No sales on this day.</div>';
  }catch(e){$('#slList').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
}

/* ----- Stock ----- */
async function renderStock(){
  $('#view').innerHTML=banner(S.detail.subscription)+'<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Stock</h2><div class="mut" id="stSub"></div></div>'+(can('inventory.manage')?'<button class="btn sm" data-act="productForm">Add product</button>':'')+'</div>'+branchSel('st_branch',ST.branchId,true)+'<input id="st_search" placeholder="Search name, SKU or barcode" value="'+esc(ST.search)+'"><div class="chips" style="margin-top:10px"><button class="chip'+(ST.low?'':' on')+'" data-act="stLow" data-v="0">All</button><button class="chip'+(ST.low?' on':'')+'" data-act="stLow" data-v="1">Low stock</button></div><div id="stList" style="margin-top:10px"><div class="empty"><span class="spin"></span></div></div></div>';
  loadStock();
}
async function loadStock(){
  try{
    const d=await api('/api/business/products?business_id='+S.bizId+(ST.branchId?'&branch_id='+ST.branchId:'')+'&limit=150&search='+encodeURIComponent(ST.search)+(ST.low?'&low=1':''));ST.list=d.products;ST.cats=d.categories;ST.units=d.units;
    const sub=$('#stSub');if(sub)sub.textContent=d.products.length+' item'+(d.products.length===1?'':'s')+(d.hasMore?'+':'');
    $('#stList').innerHTML=d.products.length?d.products.map(p=>'<div class="row" data-act="prodSheet" data-id="'+p.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(p.name)+'</div><div class="mut">'+money(p.sellPrice)+(p.category?' · '+esc(p.category):'')+(p.sku?' · '+esc(p.sku):'')+'</div></div>'+(p.trackStock?'<span class="pill '+(p.stock<=0?'bad':p.low?'warn':'ok')+'">'+p.stock+' '+esc(p.unit)+'</span>':'<span class="pill">No tracking</span>')+'</div>').join(''):'<div class="empty">'+(ST.low?'Nothing is running low.':'No products yet.')+'</div>';
  }catch(e){$('#stList').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
}

/* ----- Customers ----- */
async function renderCustomers(){
  $('#view').innerHTML='<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Customers</h2><div class="mut" id="cuSub"></div></div>'+(can('customers.manage')?'<button class="btn sm" data-act="custForm">Add customer</button>':'')+'</div><input id="cu_search" placeholder="Search name or phone" value="'+esc(CU.search)+'"><div class="chips" style="margin-top:10px"><button class="chip'+(CU.owing?'':' on')+'" data-act="cuOwing" data-v="0">All</button><button class="chip'+(CU.owing?' on':'')+'" data-act="cuOwing" data-v="1">Owing</button></div><div id="cuList" style="margin-top:10px"><div class="empty"><span class="spin"></span></div></div></div>';
  loadCustomers();
}
async function loadCustomers(){
  try{
    const d=await api('/api/business/customers?business_id='+S.bizId+'&limit=150&search='+encodeURIComponent(CU.search)+(CU.owing?'&owing=1':''));CU.list=d.customers;
    const sub=$('#cuSub');if(sub)sub.textContent=d.totalOwed>0?'Customers owe you '+money(d.totalOwed):'No outstanding balances';
    $('#cuList').innerHTML=d.customers.length?d.customers.map(c=>'<div class="row" data-act="custSheet" data-id="'+c.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(c.name)+'</div><div class="mut">'+esc(c.phone||'No phone')+'</div></div>'+(c.balance>0?'<span class="pill warn">Owes '+money(c.balance)+'</span>':c.balance<0?'<span class="pill ok">Credit '+money(-c.balance)+'</span>':'')+'</div>').join(''):'<div class="empty">No customers yet.</div>';
  }catch(e){$('#cuList').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
}

/* ----- Home extras ----- */
async function homeExtras(){
  const box=$('#homeToday');if(!box)return;let h='';
  try{
    if(can('sales.view')){const sm=await api('/api/business/sales/summary?business_id='+S.bizId);h+='<div class="stat"><span class="mut">Sales today</span><b>'+sm.count+' · '+money(sm.total)+'</b></div>'}
    if(can('inventory.view')){const lo=await api('/api/business/products?business_id='+S.bizId+'&low=1&limit=50');h+='<div class="stat" data-tab="stock" style="cursor:pointer"><span class="mut">Low stock items</span><b>'+lo.products.length+(lo.hasMore?'+':'')+'</b></div>'}
    if(can('invoices.view')){const iv=await api('/api/business/invoices?business_id='+S.bizId+'&limit=1');if(iv.outstanding>0)h+='<div class="stat" data-tab="invoices" style="cursor:pointer"><span class="mut">Unpaid invoices</span><b>'+money(iv.outstanding)+(iv.overdue>0?' <span class="pill bad">'+money(iv.overdue)+' overdue</span>':'')+'</b></div>'}
    if(can('customers.view')){const cu=await api('/api/business/customers?business_id='+S.bizId+'&limit=1');h+='<div class="stat" data-tab="customers" style="cursor:pointer"><span class="mut">Owed by customers</span><b>'+money(cu.totalOwed)+'</b></div>'}
  }catch(e){}
  if(h&&$('#homeToday'))$('#homeToday').innerHTML='<div class="card"><h2>Today</h2><div class="grid g2" style="margin-top:10px">'+h+'</div></div>';
}

/* ----- input handling (typing must not re-render the cart) ----- */
document.addEventListener('input',e=>{
  const t=e.target,k=t.dataset&&t.dataset.in;
  if(k==='qty'){const l=P.cart[Number(t.dataset.i)];if(l){l.qty=t.value.replace(',','.');updateTotals()}}
  else if(k==='disc'){P.discount=t.value;updateTotals()}
  else if(k==='pay'){P.pay[t.dataset.m]=t.value;updateTotals()}
  else if(t.id==='p_search')pSearch(t.value);
  else if(t.id==='st_search')stSearch(t.value);
  else if(t.id==='cu_search')cuSearch(t.value);
  else if(t.id==='cp_search')cpSearch(t.value);
});
const pSearch=debounce(v=>{P.search=v.trim();loadPosProducts()},250),stSearch=debounce(v=>{ST.search=v.trim();loadStock()},250),cuSearch=debounce(v=>{CU.search=v.trim();loadCustomers()},250);
const cpSearch=debounce(async v=>{try{const d=await api('/api/business/customers?business_id='+S.bizId+'&limit=20&search='+encodeURIComponent(v.trim()));$('#cpList').innerHTML=d.customers.length?d.customers.map(c=>'<div class="row" data-act="chooseCust" data-id="'+c.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(c.name)+'</div><div class="mut">'+esc(c.phone||'')+'</div></div>'+(c.balance>0?'<span class="pill warn">Owes '+money(c.balance)+'</span>':'')+'</div>').join(''):'<div class="empty">No match.</div>';P.cpFound=d.customers}catch(er){}},250);
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.id==='p_branch'){if(P.cart.length){toast('Finish or clear the current sale before changing branch');t.value=P.branchId;return}P.branchId=Number(t.value);loadPosProducts()}
  else if(t.id==='st_branch'){ST.branchId=t.value;loadStock()}
  else if(t.id==='sl_date'){SL.date=t.value||todayStr();loadSales()}
});
document.addEventListener('keydown',async e=>{
  if(e.key==='Enter'&&e.target.id==='p_search'){
    e.preventDefault();P.search=e.target.value.trim();await loadPosProducts();
    const q=P.search.toLowerCase(),hit=P.products.find(p=>(p.sku||'').toLowerCase()===q||(p.barcode||'').toLowerCase()===q)||(P.products.length===1?P.products[0]:null);
    if(hit&&!(hit.trackStock&&hit.stock<=0)){addToCart(hit);P.search='';const s=$('#p_search');if(s){s.value='';s.focus()}loadPosProducts()}
  }
});

/* ----- phase 2 actions ----- */
const UNIT_LIST=['pcs','kg','g','l','ml','pack','carton','dozen','bag','bottle','set','other'];
function actions2Init(){
  actions.auditExport=async()=>{
    const to=todayStr(),d=new Date();d.setDate(d.getDate()-89);const from=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    try{const r=await api('/api/business/audit/export?business_id='+S.bizId+'&from='+from+'&to='+to);
      const safe=v=>{v=v==null?'':typeof v==='object'?JSON.stringify(v):String(v);if(/^[=+\-@\t\r]/.test(v))v="'"+v;return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
      const rows=[['Time','Actor','Action','Entity','Entity ID','Before','After','IP']].concat(r.logs.map(l=>[l.at,l.actor,l.action,l.entity,l.entityId,l.oldValue,l.newValue,l.ip]));
      const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+rows.map(x=>x.map(safe).join(',')).join('\r\n')],{type:'text/csv'}));a.download='boltiv-audit-'+from+'-to-'+to+'.csv';document.body.appendChild(a);a.click();a.remove();toast(r.truncated?'Exported the latest 5,000 entries':'Exported '+r.logs.length+' entries');
    }catch(e){toast(e.message)}
  };
  actions.addItem=el=>{const p=P.products.find(x=>x.id===Number(el.dataset.id));if(p)addToCart(p)};
  actions.qty=el=>{const i=Number(el.dataset.i),l=P.cart[i];if(!l)return;const q=Math.round((num(l.qty)+Number(el.dataset.d))*1000)/1000;if(q<=0)P.cart.splice(i,1);else{if(l.tracked&&q>l.stock){toast('Only '+l.stock+' '+l.unit+' in stock');return}l.qty=q}renderCartPanel()};
  actions.rm=el=>{P.cart.splice(Number(el.dataset.i),1);renderCartPanel()};
  actions.clearCart=()=>{if(P.cart.length&&confirm('Clear this sale?'))resetCart()};
  actions.toCart=()=>{const c=$('#cartCard');if(c)c.scrollIntoView({behavior:'smooth',block:'start'})};
  actions.exact=()=>{P.pay={cash:String(calcCart().total/100),transfer:'',pos:''};renderCartPanel()};
  actions.noCustomer=()=>{P.customer=null;renderCartPanel()};
  actions.customItem=()=>{sheet('<h2>Custom item</h2><div class="mut">For something not in your product list. Stock is not tracked.</div><label>DESCRIPTION</label><input id="ci_name" maxlength="120"><div class="grid g2"><div><label>PRICE (₦)</label><input id="ci_price" inputmode="decimal"></div><div><label>QUANTITY</label><input id="ci_qty" inputmode="decimal" value="1"></div></div><br><button class="btn block" data-act="addCustom">Add to cart</button><br><button class="btn ghost block" data-act="close">Cancel</button>')};
  actions.addCustom=()=>{const n=$('#ci_name').value.trim(),p=num($('#ci_price').value),q=num($('#ci_qty').value);if(n.length<2||!(p>=0)||!(q>0)){toast('Enter a description, price and quantity');return}P.cart.push({productId:null,name:n,price:p,qty:q,tracked:false,unit:'pcs'});P.idem=P.idem||uidk();closeSheet();renderCartPanel()};
  actions.pickCustomer=()=>{sheet('<h2>Customer</h2><input id="cp_search" placeholder="Search name or phone" autocomplete="off"><div id="cpList" style="margin-top:8px"></div>'+(can('customers.manage')?'<div class="card" style="margin:12px 0 0"><h2>New customer</h2><label>NAME</label><input id="nc_name" maxlength="80"><label>PHONE</label><input id="nc_phone" inputmode="tel" maxlength="20"><br><button class="btn block" data-act="newCustPick">Add and select</button></div>':'')+'<br><button class="btn ghost block" data-act="close">Cancel</button>');cpSearch('')};
  actions.chooseCust=el=>{const c=(P.cpFound||[]).find(x=>x.id===Number(el.dataset.id));if(!c)return;P.customer={id:c.id,name:c.name,phone:c.phone,balance:c.balance};closeSheet();renderCartPanel()};
  actions.newCustPick=async el=>{busy(el,true,'Saving…');try{const d=await api('/api/business/customers/save',{body:{businessId:S.bizId,name:$('#nc_name').value,phone:$('#nc_phone').value}});P.customer={id:d.customerId,name:$('#nc_name').value.trim(),phone:$('#nc_phone').value.trim(),balance:0};closeSheet();renderCartPanel()}catch(e){toast(e.message);busy(el,false)}};
  actions.syncNow=()=>syncQueue();
  actions.discardQ=el=>{if(confirm('Discard this saved sale? It will not be recorded.')){Q.save(Q.load().filter(x=>x.body.idempotencyKey!==el.dataset.k));renderPending()}};
  actions.complete=async el=>{
    const payments=[['cash',P.pay.cash],['transfer',P.pay.transfer],['pos',P.pay.pos]].filter(x=>num(x[1])>0).map(x=>({method:x[0],amount:num(x[1])}));
    const body={businessId:S.bizId,branchId:P.branchId,customerId:P.customer?P.customer.id:undefined,discount:num(P.discount)||undefined,
      items:P.cart.map(l=>l.productId?{productId:l.productId,qty:num(l.qty)}:{name:l.name,price:l.price,qty:num(l.qty)}),payments,idempotencyKey:P.idem||(P.idem=uidk())};
    busy(el,true,'Completing…');
    try{const d=await api('/api/business/sales/create',{body});const appt=P.apptId;resetCart();showReceipt(d.sale,d.receipt,{canVoid:can('sales.void')});loadPosProducts();if(appt)api('/api/business/appointments/status',{body:{businessId:S.bizId,appointmentId:appt,status:'completed',saleId:d.sale.id}}).then(()=>toast('Appointment marked completed')).catch(()=>{})}
    catch(e){if(e.message==='auth')return;busy(el,false);if(!e.status){queueSale(body);return}toast(e.message);if(e.data&&e.data.code==='insufficient_stock')loadPosProducts();updateTotals()}
  };
  actions.printRcpt=el=>printReceipt(Number(el.dataset.w));
  actions.viewSale=async el=>{try{const d=await api('/api/business/sales/detail?business_id='+S.bizId+'&id='+el.dataset.id);showReceipt(d.sale,d.receipt,{history:true,canVoid:d.canVoid})}catch(e){toast(e.message)}};
  actions.voidSale=async el=>{
    const reason=prompt('Why are you voiding this sale? (required)');if(!reason||reason.trim().length<3)return;if(!confirm('Void this sale? Stock will be returned.'))return;
    try{const d=await api('/api/business/sales/void',{body:{businessId:S.bizId,saleId:Number(el.dataset.id),reason:reason.trim()}});toast(d.message);closeSheet();if(S.tab==='sales')loadSales()}catch(e){toast(e.message)}
  };
  /* stock */
  actions.stLow=el=>{ST.low=el.dataset.v==='1';renderStock()};
  actions.productForm=el=>{
    const id=el&&el.dataset&&el.dataset.id?Number(el.dataset.id):null,p=id?ST.list.find(x=>x.id===id):null,bs=activeBranches();
    sheet('<h2>'+(p?'Edit product':'Add product')+'</h2><label>NAME</label><input id="pf_name" maxlength="120" value="'+esc(p?p.name:'')+'">'+
      '<div class="grid g2"><div><label>SELLING PRICE (₦)</label><input id="pf_price" inputmode="decimal" value="'+(p?p.sellPrice:'')+'"></div><div><label>COST PRICE (₦)</label><input id="pf_cost" inputmode="decimal" value="'+(p&&p.costPrice!==undefined?p.costPrice:'')+'"></div></div>'+
      '<div class="grid g2"><div><label>UNIT</label><select class="f" id="pf_unit">'+(ST.units||UNIT_LIST).map(u=>'<option'+((p?p.unit:'pcs')===u?' selected':'')+'>'+u+'</option>').join('')+'</select></div><div><label>CATEGORY</label><input id="pf_cat" list="pf_cats" maxlength="40" value="'+esc(p&&p.category||'')+'"><datalist id="pf_cats">'+(ST.cats||[]).map(c=>'<option value="'+esc(c)+'">').join('')+'</datalist></div></div>'+
      '<div class="grid g2"><div><label>SKU (OPTIONAL)</label><input id="pf_sku" maxlength="40" value="'+esc(p&&p.sku||'')+'"></div><div><label>BARCODE (OPTIONAL)</label><input id="pf_bar" maxlength="40" value="'+esc(p&&p.barcode||'')+'"></div></div>'+
      '<div class="chk"><label><input type="checkbox" id="pf_track"'+(!p||p.trackStock?' checked':'')+'> Track stock for this item</label></div><label>LOW-STOCK ALERT AT</label><input id="pf_reorder" inputmode="decimal" value="'+(p?p.reorderLevel:'')+'" placeholder="0">'+
      (!p?'<label>OPENING STOCK</label><div class="grid g2"><input id="pf_open" inputmode="decimal" placeholder="Quantity on hand" style="margin:0">'+(bs.length>1?'<select class="f" id="pf_obr" style="margin:0">'+bs.map(b=>'<option value="'+b.id+'">'+esc(b.name)+'</option>').join('')+'</select>':'<span></span>')+'</div>':'')+
      '<br><button class="btn block" data-act="saveProduct" data-id="'+(id||'')+'">Save product</button>'+(p?'<br><button class="btn bad block" data-act="archiveProduct" data-id="'+id+'">'+(p.status==='archived'?'Restore':'Archive')+' product</button>':'')+'<br><button class="btn ghost block" data-act="close">Cancel</button>');
  };
  actions.saveProduct=async el=>{
    const id=el.dataset.id?Number(el.dataset.id):null,g=x=>$('#'+x).value.trim();
    const body={businessId:S.bizId,id:id||undefined,name:g('pf_name'),sellPrice:g('pf_price')===''?undefined:num(g('pf_price')),costPrice:num(g('pf_cost')),unit:g('pf_unit'),category:g('pf_cat'),sku:g('pf_sku'),barcode:g('pf_bar'),trackStock:$('#pf_track').checked,reorderLevel:num(g('pf_reorder'))};
    if(!id&&num(g('pf_open'))>0)body.openingStock={branchId:$('#pf_obr')?Number($('#pf_obr').value):activeBranches()[0].id,qty:num(g('pf_open'))};
    busy(el,true,'Saving…');
    try{const d=await api('/api/business/products/save',{body});toast(d.message);closeSheet();if(S.tab==='stock')loadStock();if(S.tab==='sell')loadPosProducts()}catch(e){toast(e.message);busy(el,false)}
  };
  actions.archiveProduct=async el=>{
    const p=ST.list.find(x=>x.id===Number(el.dataset.id));if(!p||!confirm((p.status==='archived'?'Restore':'Archive')+' '+p.name+'?'))return;
    try{const d=await api('/api/business/products/save',{body:{businessId:S.bizId,id:p.id,status:p.status==='archived'?'active':'archived'}});toast(d.message);closeSheet();loadStock()}catch(e){toast(e.message)}
  };
  actions.prodSheet=el=>{
    const p=ST.list.find(x=>x.id===Number(el.dataset.id));if(!p)return;
    sheet('<h2>'+esc(p.name)+'</h2><div class="mut">'+esc([p.category,p.sku,p.barcode].filter(Boolean).join(' · '))+'</div><div class="grid g2" style="margin-top:12px"><div class="stat"><span class="mut">Price</span><b>'+money(p.sellPrice)+'</b></div><div class="stat"><span class="mut">'+(ST.branchId?'In stock':'Total in stock')+'</span><b>'+(p.trackStock?p.stock+' '+esc(p.unit):'Not tracked')+'</b></div>'+(p.costPrice!==undefined?'<div class="stat"><span class="mut">Cost</span><b>'+money(p.costPrice)+'</b></div><div class="stat"><span class="mut">Margin</span><b>'+(p.sellPrice>0?Math.round((p.sellPrice-p.costPrice)/p.sellPrice*100)+'%':'—')+'</b></div>':'')+'</div><br>'+
      (can('inventory.manage')&&p.trackStock?'<button class="btn block" data-act="adjustForm" data-id="'+p.id+'">Adjust stock</button><br>':'')+(p.trackStock?'<button class="btn ghost block" data-act="history" data-id="'+p.id+'">Stock history</button><br>':'')+(can('inventory.manage')?'<button class="btn ghost block" data-act="productForm" data-id="'+p.id+'">Edit product</button><br>':'')+'<button class="btn ghost block" data-act="close">Close</button>');
  };
  actions.adjustForm=el=>{
    const p=ST.list.find(x=>x.id===Number(el.dataset.id));if(!p)return;
    sheet('<h2>Adjust stock</h2><div class="mut">'+esc(p.name)+'</div>'+branchSel('ad_branch',ST.branchId||activeBranches()[0].id)+'<label>WHAT HAPPENED?</label><select class="f" id="ad_type"><option value="restock">Received more stock (+)</option><option value="damage">Damaged, expired or lost (−)</option><option value="correction">Stock count (set exact quantity)</option></select><label id="ad_qlabel">QUANTITY</label><input id="ad_qty" inputmode="decimal" placeholder="0">'+(planFeat('advanced_inventory')?'<div id="ad_exp"><label>EXPIRY DATE (OPTIONAL, FOR NEW STOCK)</label><input type="date" id="ad_expiry"><label>BATCH / LOT NO. (OPTIONAL)</label><input id="ad_lot" maxlength="40"></div>':'')+'<label>NOTE (REQUIRED FOR DAMAGE OR COUNT)</label><input id="ad_note" maxlength="200"><br><button class="btn block" data-act="saveAdjust" data-id="'+p.id+'">Save</button><br><button class="btn ghost block" data-act="close">Cancel</button>');
  };
  actions.saveAdjust=async el=>{
    busy(el,true,'Saving…');
    try{const d=await api('/api/business/stock/adjust',{body:{businessId:S.bizId,branchId:$('#ad_branch')?Number($('#ad_branch').value):(ST.branchId?Number(ST.branchId):activeBranches()[0].id),productId:Number(el.dataset.id),type:$('#ad_type').value,qty:num($('#ad_qty').value),note:$('#ad_note').value,expiry:($('#ad_type').value==='restock'&&$('#ad_expiry')&&$('#ad_expiry').value)||undefined,lotNo:($('#ad_lot')&&$('#ad_lot').value.trim())||undefined}});toast(d.message+' · now '+d.quantity);closeSheet();loadStock()}
    catch(e){toast(e.message);busy(el,false)}
  };
  actions.history=async el=>{
    try{const d=await api('/api/business/stock/movements?business_id='+S.bizId+'&product_id='+el.dataset.id);
      sheet('<h2>Stock history</h2>'+(d.movements.length?d.movements.map(m=>'<div class="row"><div class="grow"><div class="nm" style="text-transform:capitalize">'+esc(m.type)+(m.branch?' · '+esc(m.branch):'')+'</div><div class="mut">'+new Date(m.at).toLocaleString('en-NG',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+(m.actor?' · '+esc(m.actor):'')+(m.note?' · '+esc(m.note):'')+'</div></div><div style="text-align:right"><b style="color:var(--'+(m.change>=0?'ok':'bad')+')">'+(m.change>0?'+':'')+m.change+'</b><div class="mut">→ '+m.balance+'</div></div></div>').join(''):'<div class="empty">No movements yet.</div>')+'<br><button class="btn ghost block" data-act="close">Close</button>')}
    catch(e){toast(e.message)}
  };
  /* customers */
  actions.cuOwing=el=>{CU.owing=el.dataset.v==='1';renderCustomers()};
  actions.custForm=el=>{
    const c=el&&el.dataset&&el.dataset.edit&&S.cdetail?S.cdetail.customer:null;
    sheet('<h2>'+(c?'Edit customer':'Add customer')+'</h2><label>NAME</label><input id="cf_name" maxlength="80" value="'+esc(c?c.name:'')+'"><label>PHONE</label><input id="cf_phone" inputmode="tel" maxlength="20" value="'+esc(c&&c.phone||'')+'"><label>EMAIL (OPTIONAL)</label><input id="cf_email" maxlength="120" value="'+esc(c&&c.email||'')+'"><label>ADDRESS (OPTIONAL)</label><input id="cf_addr" maxlength="200" value="'+esc(c&&c.address||'')+'"><label>NOTES (OPTIONAL)</label><input id="cf_notes" maxlength="300" value="'+esc(c&&c.notes||'')+'"><br><button class="btn block" data-act="saveCust" data-id="'+(c?c.id:'')+'">Save customer</button><br><button class="btn ghost block" data-act="close">Cancel</button>');
  };
  actions.saveCust=async el=>{
    const g=x=>$('#'+x).value.trim();busy(el,true,'Saving…');
    try{const d=await api('/api/business/customers/save',{body:{businessId:S.bizId,id:el.dataset.id?Number(el.dataset.id):undefined,name:g('cf_name'),phone:g('cf_phone'),email:g('cf_email'),address:g('cf_addr'),notes:g('cf_notes')}});toast(d.message);closeSheet();if(S.tab==='customers')loadCustomers()}
    catch(e){toast(e.message);busy(el,false)}
  };
  actions.custSheet=async el=>{
    try{
      const d=await api('/api/business/customers/detail?business_id='+S.bizId+'&id='+el.dataset.id);S.cdetail=d;S.custIdem=uidk();const c=d.customer,mg=can('customers.manage');
      sheet('<h2>'+esc(c.name)+'</h2><div class="mut">'+esc([c.phone,c.email].filter(Boolean).join(' · ')||'No contact details')+'</div><div class="stat" style="margin-top:12px"><span class="mut">'+(c.balance>0?'Owes you':c.balance<0?'Credit with you':'Balance')+'</span><b>'+money(Math.abs(c.balance))+'</b></div>'+
        (mg&&c.balance>0?'<label>RECORD A PAYMENT (₦)</label><div class="grid g2"><input id="cs_amt" inputmode="decimal" placeholder="'+c.balance+'" style="margin:0"><select class="f" id="cs_method" style="margin:0"><option value="cash">Cash</option><option value="transfer">Transfer</option><option value="pos">POS</option><option value="other">Other</option></select></div><button class="btn block" style="margin-top:10px" data-act="recPay" data-id="'+c.id+'">Record payment</button>':'')+
        (d.ledger.length?'<h2 style="margin-top:16px">Account</h2>'+d.ledger.slice(0,12).map(l=>'<div class="row"><div class="grow"><div class="nm" style="text-transform:capitalize">'+esc(l.type.replace('_',' '))+(l.method?' · '+esc(l.method):'')+'</div><div class="mut">'+dt(l.at)+'</div></div><b style="color:var(--'+(l.amount>0?'warn':'ok')+')">'+(l.amount>0?'+':'−')+money(Math.abs(l.amount))+'</b></div>').join(''):'')+
        (d.sales.length?'<h2 style="margin-top:16px">Recent sales</h2>'+d.sales.slice(0,8).map(s=>'<div class="row" data-act="viewSale" data-id="'+s.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(s.receiptNo)+(s.status==='void'?' <span class="pill bad">VOID</span>':'')+'</div><div class="mut">'+dt(s.at)+'</div></div><b>'+money(s.total)+'</b></div>').join(''):'')+
        '<br>'+(mg?'<button class="btn ghost block" data-act="custForm" data-edit="1">Edit details</button><br>':'')+'<button class="btn ghost block" data-act="close">Close</button>');
    }catch(e){toast(e.message)}
  };
  actions.recPay=async el=>{
    busy(el,true,'Saving…');
    try{const d=await api('/api/business/customers/payment',{body:{businessId:S.bizId,customerId:Number(el.dataset.id),amount:num($('#cs_amt').value),method:$('#cs_method').value,idempotencyKey:S.custIdem}});toast(d.message);closeSheet();if(S.tab==='customers')loadCustomers()}
    catch(e){toast(e.message);busy(el,false)}
  };
}

/* ---------- actions ---------- */
const actions={};
function actionsInit(){
  actions.retry=()=>boot();
  actions.pickPlan=el=>{
    if(S.tab!=='billing'||!$('#planList'))return;
    B.planKey=el.dataset.key;[...document.querySelectorAll('#planList .plan')].forEach(p=>p.classList.toggle('sel',p.dataset.key===B.planKey));loadQuote();
  };
  actions.period=el=>{B.months=Number(el.dataset.m);[...document.querySelectorAll('#seg button')].forEach(b=>b.classList.toggle('on',Number(b.dataset.m)===B.months));loadQuote()};
  actions.createBiz=async el=>{
    const g=id=>$('#'+id).value.trim();
    busy(el,true,'Creating…');
    try{
      const d=await api('/api/business/create',{body:{name:g('f_name'),industry:g('f_industry'),state:g('f_state'),phone:g('f_phone'),email:g('f_email'),address:g('f_address'),tin:g('f_tin')}});
      toast(d.message);const m=await api('/api/business/mine');S.businesses=m.businesses;S.tab=d.trial?'home':'billing';await selectBiz(d.businessId);
    }catch(e){toast(e.message);busy(el,false)}
  };
  /* ----- business logo (shown on receipts and invoices) ----- */
  let LOGO_NEW; /* undefined = unchanged, '' = remove, data URL = new image */
  const initialsOf=n=>{const p=String(n||'B').replace(/[^A-Za-z0-9 ]/g,' ').split(/\s+/).filter(Boolean);return ((p[0]||'B').charAt(0)+(p[1]?p[1].charAt(0):'')).toUpperCase()};
  const logoPrev=(src,name)=>src?'<img src="'+esc(src)+'" alt="Logo">':esc(initialsOf(name));
  function shrinkLogo(file){return new Promise((res,rej)=>{
    if(!/^image\/(png|jpe?g|webp)$/i.test(file.type))return rej(new Error('Choose a PNG, JPG or WebP image.'));
    const url=URL.createObjectURL(file),img=new Image();
    img.onload=()=>{URL.revokeObjectURL(url);
      for(const max of [256,192,128]){
        const k=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight)),w=Math.max(1,Math.round(img.naturalWidth*k)),h=Math.max(1,Math.round(img.naturalHeight*k));
        const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);
        let out=c.toDataURL('image/png');
        if(out.length>110000){const c2=document.createElement('canvas');c2.width=w;c2.height=h;const x=c2.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,w,h);x.drawImage(img,0,0,w,h);out=c2.toDataURL('image/jpeg',.85)}
        if(out.length<=120000)return res(out);
      }
      rej(new Error('That image is too detailed. Try a simpler logo.'));
    };
    img.onerror=()=>{URL.revokeObjectURL(url);rej(new Error('Could not read that image.'))};img.src=url;
  })}
  actions.editBiz=()=>{
    const b=S.detail.business;LOGO_NEW=undefined;
    const m=sheet('<h2>Edit business</h2><label>BUSINESS LOGO</label><div class="logoup"><div class="logoprev" id="e_logoprev">'+logoPrev(b.logo,b.name)+'</div><div><button type="button" class="btn ghost sm" data-act="logoPick">Choose image</button> <button type="button" class="btn ghost sm" data-act="logoClear">Remove</button><div class="mut" style="margin-top:6px">Shown on your receipts and invoices. A square PNG or JPG works best.</div></div><input type="file" id="e_logofile" accept="image/png,image/jpeg,image/webp" hidden></div><label>BUSINESS NAME</label><input id="e_name" maxlength="80" value="'+esc(b.name)+'"><label>TYPE</label><input id="e_industry" maxlength="40" value="'+esc(b.industry||'')+'">'+
      '<label>STATE</label><select class="f" id="e_state"><option value="">Select state</option>'+STATES.map(s=>'<option'+(s===b.state?' selected':'')+'>'+s+'</option>').join('')+'</select>'+
      '<label>PHONE</label><input id="e_phone" maxlength="20" value="'+esc(b.phone||'')+'"><label>EMAIL</label><input id="e_email" maxlength="120" value="'+esc(b.email||'')+'"><label>ADDRESS</label><input id="e_address" maxlength="200" value="'+esc(b.address||'')+'"><label>TIN</label><input id="e_tin" maxlength="20" value="'+esc(b.tin||'')+'">'+
      '<label>VAT RATE (%) — 0 IF NOT REGISTERED</label><input id="e_vat" inputmode="decimal" value="'+(b.vatRate||0)+'"><div class="chk"><label><input type="checkbox" id="e_vatinc"'+(b.vatInclusive?' checked':'')+'> My prices already include VAT</label></div><label>RECEIPT FOOTER</label><input id="e_footer" maxlength="120" value="'+esc(b.receiptFooter||'')+'" placeholder="Thank you for your patronage!">'+
      '<br><button class="btn block" data-act="saveBiz">Save changes</button><br><button class="btn ghost block" data-act="close">Cancel</button>');
    const f=$('#e_logofile');if(f)f.onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;try{LOGO_NEW=await shrinkLogo(file);$('#e_logoprev').innerHTML=logoPrev(LOGO_NEW,b.name)}catch(err){toast(err.message)}};
  };
  actions.logoPick=()=>{const f=$('#e_logofile');if(f)f.click()};
  actions.logoClear=()=>{LOGO_NEW='';const p=$('#e_logoprev');if(p)p.innerHTML=logoPrev('',S.detail.business.name)};
  actions.close=()=>closeSheet();
  actions.saveBiz=async el=>{
    const g=id=>$('#'+id).value.trim();busy(el,true,'Saving…');
    try{const body={businessId:S.bizId,name:g('e_name'),industry:g('e_industry'),state:g('e_state'),phone:g('e_phone'),email:g('e_email'),address:g('e_address'),tin:g('e_tin'),vatRate:Number($('#e_vat').value||0),vatInclusive:$('#e_vatinc').checked,receiptFooter:g('e_footer')};if(LOGO_NEW!==undefined)body.logo=LOGO_NEW;const d=await api('/api/business/update',{body});toast(d.message);closeSheet();await selectBiz(S.bizId)}
    catch(e){toast(e.message);busy(el,false)}
  };
  actions.branchForm=el=>{
    const id=el.dataset.id?Number(el.dataset.id):null,x=id?S.detail.branches.find(b=>b.id===id):{name:'',address:'',phone:'',status:'active',isMain:false};
    sheet('<h2>'+(id?'Edit branch':'Add branch')+'</h2><label>BRANCH NAME</label><input id="b_name" maxlength="60" value="'+esc(x.name)+'"><label>ADDRESS</label><input id="b_address" maxlength="200" value="'+esc(x.address||'')+'"><label>PHONE</label><input id="b_phone" maxlength="20" value="'+esc(x.phone||'')+'">'+
      (id&&!x.isMain?'<label>STATUS</label><select class="f" id="b_status"><option value="active"'+(x.status==='active'?' selected':'')+'>Active</option><option value="inactive"'+(x.status!=='active'?' selected':'')+'>Inactive</option></select>':'')+
      '<br><button class="btn block" data-act="saveBranch" data-id="'+(id||'')+'">Save branch</button><br><button class="btn ghost block" data-act="close">Cancel</button>');
  };
  actions.saveBranch=async el=>{
    busy(el,true,'Saving…');
    try{const st=$('#b_status');const d=await api('/api/business/branches/save',{body:{businessId:S.bizId,id:el.dataset.id?Number(el.dataset.id):undefined,name:$('#b_name').value,address:$('#b_address').value,phone:$('#b_phone').value,status:st?st.value:'active'}});toast(d.message);closeSheet();await selectBiz(S.bizId)}
    catch(e){toast(e.message);busy(el,false)}
  };
  actions.memberForm=el=>{
    const id=el.dataset.id?Number(el.dataset.id):null,t=S.team,m=id?t.members.find(x=>x.id===id):null;
    const roles=t.assignableRoles;
    const brs=S.detail.branches.filter(b=>b.status==='active');
    sheet('<h2>'+(m?'Edit team member':'Add team member')+'</h2>'+
      (m?'<div class="mut">'+esc(m.name||m.email)+'</div>':'<label>THEIR BOLTIV EMAIL</label><input id="m_email" type="email" maxlength="120" placeholder="name@email.com"><div class="mut" style="margin-top:6px">They must already have a BOLTIV account.</div>')+
      '<label>ROLE</label><select class="f" id="m_role">'+roles.map(r=>'<option value="'+r+'"'+(m&&m.role===r?' selected':'')+'>'+ROLE[r]+'</option>').join('')+'</select>'+
      '<label>BRANCH ACCESS</label><div class="chk"><label><input type="checkbox" id="m_all"'+(!m||!m.branchIds?' checked':'')+'> All branches</label>'+brs.map(b=>'<label><input type="checkbox" class="m_br" value="'+b.id+'"'+(m&&m.branchIds&&m.branchIds.includes(b.id)?' checked':'')+'> '+esc(b.name)+'</label>').join('')+'</div>'+
      (m?'<label>STATUS</label><select class="f" id="m_status"><option value="active"'+(m.status==='active'?' selected':'')+'>Active</option><option value="inactive"'+(m.status!=='active'?' selected':'')+'>Suspended</option></select>':'')+
      '<br><button class="btn block" data-act="saveMember" data-id="'+(id||'')+'">'+(m?'Save changes':'Add to team')+'</button>'+(m?'<br><button class="btn bad block" data-act="removeMember" data-id="'+id+'">Remove from team</button>':'')+'<br><button class="btn ghost block" data-act="close">Cancel</button>');
  };
  const branchSel=()=>{const all=$('#m_all').checked;return all?[]:[...document.querySelectorAll('.m_br:checked')].map(x=>Number(x.value))};
  actions.saveMember=async el=>{
    busy(el,true,'Saving…');const id=el.dataset.id?Number(el.dataset.id):null;
    try{
      const body=id?{businessId:S.bizId,memberId:id,role:$('#m_role').value,status:$('#m_status').value,branchIds:branchSel()}:{businessId:S.bizId,email:$('#m_email').value,role:$('#m_role').value,branchIds:branchSel()};
      const d=await api(id?'/api/business/members/update':'/api/business/members/add',{body});toast(d.message);closeSheet();await selectBiz(S.bizId);S.tab='team';render();
    }catch(e){toast(e.message);busy(el,false)}
  };
  actions.removeMember=async el=>{
    if(!confirm('Remove this person from the business?'))return;
    try{const d=await api('/api/business/members/remove',{body:{businessId:S.bizId,memberId:Number(el.dataset.id)}});toast(d.message);closeSheet();await selectBiz(S.bizId);S.tab='team';render()}catch(e){toast(e.message)}
  };
  actions.pay=async el=>{
    const q=B.quote&&B.quote.quote;if(!q)return;
    const pin=await window.boltivGetTransactionPin();if(!pin)return;
    if(!B.idem)B.idem=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random());
    busy(el,true,'Processing…');
    try{
      const d=await api('/api/business/subscription/pay',{body:{businessId:S.bizId,planKey:B.planKey,months:B.months,expectedAmount:q.amount,transactionPin:pin,idempotencyKey:B.idem}});
      toast(d.message);B.idem=null;S.tab='home';await selectBiz(S.bizId);
    }catch(e){
      toast(e.message);busy(el,false);
      if(e.data&&e.data.code==='price_changed')loadQuote();
    }
  };
}

/* ---------- extension API (used by business-finance.js) ---------- */
const EXT={tabs:{}};
window.BM={S,api,toast,sheet,closeSheet,esc,money,m2,dt,num,uidk,can,busy,debounce,activeBranches,branchSel,banner,actions,todayStr,
  addTab(id,label,icon,perm,fn,after){if(NAV.some(n=>n[0]===id))return;const at=NAV.findIndex(n=>n[0]===after);NAV.splice(at>=0?at+1:NAV.findIndex(n=>n[0]==='more'),0,[id,label,icon]);PERM_OF[id]=perm;EXT.tabs[id]=fn},
  feat:planFeat,startSale(o){P.cart=(o.items||[]).map(i=>({productId:null,name:i.name,price:i.price,qty:i.qty||1,tracked:false,unit:'pcs'}));P.customer=o.customer||null;P.apptId=o.apptId||null;P.discount='';P.pay={cash:'',transfer:'',pos:''};P.idem=uidk();S.tab='sell';render()},
  refresh(){if(S.bizId&&S.detail)render()}};

actionsInit();
actions2Init();
boot();
})();
