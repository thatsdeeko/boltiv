/* BOLTIV Business Manager, Phase 3 screens: Expenses, Suppliers & purchases, Invoices, Finance.
   Plugs into business.js through window.BM. */
(function(){
'use strict';
if(!window.BM)return;
const {S,api,toast,sheet,closeSheet,esc,money,m2,dt,num,uidk,can,busy,debounce,activeBranches,branchSel,banner,actions,todayStr}=BM;
const $=s=>document.querySelector(s);
const ic=p=>p;
const METHODS=[['cash','Cash'],['transfer','Transfer'],['pos','POS'],['other','Other']];
const methodSel=(id,v)=>'<select class="f" id="'+id+'">'+METHODS.map(m=>'<option value="'+m[0]+'"'+(m[0]===(v||'cash')?' selected':'')+'>'+m[1]+'</option>').join('')+'</select>';
const monthRange=m=>{const [y,mo]=m.split('-').map(Number);return {from:m+'-01',to:m+'-'+String(new Date(y,mo,0).getDate()).padStart(2,'0')}};
const addD=(d,n)=>{const t=new Date(d+'T00:00:00');t.setDate(t.getDate()+n);return t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0')};
const mname=m=>new Date(m+'-01T00:00:00').toLocaleDateString('en-NG',{month:'long',year:'numeric'});
const needBiz=()=>'business_id='+S.bizId;
const guard=async fn=>{try{await fn()}catch(e){if(e&&e.message!=='auth')toast(e.message)}};
const safeCell=v=>typeof v==='string'&&/^[=+\-@\t\r]/.test(v)?"'"+v:v;
function download(name,rows){
  const csv=rows.map(r=>r.map(c=>{const s=String(safeCell(c)??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}).join(',')).join('\r\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv'}));a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),3000);
}
const ICON={
  finance:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  invoices:'<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h7"/>',
  expenses:'<rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M8 12h8"/>',
  suppliers:'<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>'
};

/* ================= Expenses ================= */
let EX={month:todayStr().slice(0,7),cat:'',branch:'',list:[],meta:{},idem:null};
function renderExpenses(){
  $('#view').innerHTML=banner(S.detail.subscription)+'<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Expenses</h2><div class="mut" id="exSub"></div></div>'+(can('expenses.manage')?'<button class="btn sm" data-act="exForm">Add expense</button>':'')+'</div>'+
    '<div class="grid g2"><input type="month" id="ex_month" value="'+EX.month+'" max="'+todayStr().slice(0,7)+'"><select class="f" id="ex_cat"><option value="">All categories</option></select></div>'+branchSel('ex_branch',EX.branch,true)+'<div id="exSum" style="margin-top:12px"></div></div><div class="card"><div id="exList"><div class="empty"><span class="spin"></span></div></div></div>';
  loadExpenses();
}
function loadExpenses(){guard(async()=>{
  const r=monthRange(EX.month),d=await api('/api/business/expenses?'+needBiz()+'&from='+r.from+'&to='+r.to+'&limit=200'+(EX.cat?'&category='+encodeURIComponent(EX.cat):'')+(EX.branch?'&branch_id='+EX.branch:''));
  EX.list=d.expenses;EX.meta=d;
  const sel=$('#ex_cat');if(sel)sel.innerHTML='<option value="">All categories</option>'+d.categories.map(c=>'<option'+(c===EX.cat?' selected':'')+'>'+esc(c)+'</option>').join('');
  const sub=$('#exSub');if(sub)sub.textContent=mname(EX.month)+' · '+money(d.total);
  const max=Math.max(1,...d.byCategory.map(c=>c.amount));
  $('#exSum').innerHTML=d.byCategory.length?d.byCategory.slice(0,6).map(c=>'<div style="margin:6px 0"><div class="row" style="border:0;padding:0"><div class="grow" style="font-size:13px">'+esc(c.category)+'</div><b style="font-size:13px">'+money(c.amount)+'</b></div><div class="bar1"><i style="width:'+Math.max(3,Math.round(c.amount/max*100))+'%"></i></div></div>').join(''):'';
  $('#exList').innerHTML=d.expenses.length?d.expenses.map(e=>'<div class="row" data-act="exSheet" data-id="'+e.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(e.category)+(e.status==='void'?' <span class="pill bad">VOID</span>':'')+'</div><div class="mut">'+dt(e.date)+(e.description?' · '+esc(e.description):'')+(e.branch?' · '+esc(e.branch):'')+'</div></div><b>'+money(e.amount)+'</b></div>').join(''):'<div class="empty">No expenses recorded for this month.</div>';
})}
actions.exForm=el=>{
  const id=el&&el.dataset&&el.dataset.id?Number(el.dataset.id):null,e=id?EX.list.find(x=>x.id===id):null,cats=EX.meta.categories||[];
  if(!id)EX.idem=uidk();
  const bs=activeBranches();
  sheet('<h2>'+(e?'Edit expense':'Add expense')+'</h2><label>AMOUNT (₦)</label><input id="ef_amt" inputmode="decimal" value="'+(e?e.amount:'')+'" placeholder="0"><label>CATEGORY</label><select class="f" id="ef_cat">'+cats.map(c=>'<option'+((e?e.category:'')===c?' selected':'')+'>'+esc(c)+'</option>').join('')+'</select>'+
    '<label>WHAT WAS IT FOR? (OPTIONAL)</label><input id="ef_desc" maxlength="200" value="'+esc(e&&e.description||'')+'"><div class="grid g2"><div><label>DATE</label><input type="date" id="ef_date" value="'+(e?e.date:todayStr())+'" max="'+todayStr()+'"></div><div><label>PAID BY</label>'+methodSel('ef_method',e&&e.method)+'</div></div>'+
    (bs.length>1||EX.meta.restricted?'<label>BRANCH</label><select class="f" id="ef_branch">'+(EX.meta.restricted?'':'<option value="">Whole business</option>')+bs.map(b=>'<option value="'+b.id+'"'+(e&&e.branchId===b.id?' selected':'')+'>'+esc(b.name)+'</option>').join('')+'</select>':(EX.meta.restricted?'':''))+
    '<br><button class="btn block" data-act="exSave" data-id="'+(id||'')+'">'+(e?'Save changes':'Save expense')+'</button><br><button class="btn ghost block" data-act="close">Cancel</button>');
};
actions.exSave=async el=>{
  const id=el.dataset.id?Number(el.dataset.id):null,g=x=>$('#'+x).value.trim(),br=$('#ef_branch')?$('#ef_branch').value:(EX.meta.restricted?String(activeBranches()[0].id):'');
  busy(el,true,'Saving…');
  try{const d=await api('/api/business/expenses/save',{body:{businessId:S.bizId,id:id||undefined,amount:num(g('ef_amt')),category:g('ef_cat'),description:g('ef_desc'),date:g('ef_date'),method:g('ef_method'),branchId:id&&!$('#ef_branch')?undefined:br,idempotencyKey:id?undefined:EX.idem}});toast(d.message);closeSheet();loadExpenses()}
  catch(e){toast(e.message);busy(el,false)}
};
actions.exSheet=el=>{
  const e=EX.list.find(x=>x.id===Number(el.dataset.id));if(!e)return;
  sheet('<h2>'+money(e.amount)+'</h2><div class="mut">'+esc(e.category)+' · '+dt(e.date)+' · '+esc(e.method)+'</div>'+(e.description?'<p>'+esc(e.description)+'</p>':'')+'<div class="mut">'+(e.branch?'Branch: '+esc(e.branch)+' · ':'')+(e.by?'Recorded by '+esc(e.by):'')+'</div>'+(e.status==='void'?'<div class="banner bad" style="margin-top:12px">Voided: '+esc(e.voidReason||'')+'</div>':'')+
    '<br>'+(EX.meta.canManage&&e.status==='active'?'<button class="btn ghost block" data-act="exForm" data-id="'+e.id+'">Edit</button><br><button class="btn bad block" data-act="exVoid" data-id="'+e.id+'">Void this expense</button><br>':'')+'<button class="btn ghost block" data-act="close">Close</button>');
};
actions.exVoid=async el=>{
  const reason=prompt('Why are you voiding this expense? (required)');if(!reason||reason.trim().length<3||!confirm('Void this expense?'))return;
  guard(async()=>{const d=await api('/api/business/expenses/void',{body:{businessId:S.bizId,expenseId:Number(el.dataset.id),reason:reason.trim()}});toast(d.message);closeSheet();loadExpenses()});
};

/* ================= Suppliers & purchases ================= */
let SU={seg:'suppliers',search:'',owing:false,list:[],pl:[]},PO={rows:[],prods:[],map:{},idem:null};
function renderSuppliers(){
  const seg=can('purchases.view')?'<div class="chips" style="margin:0 0 12px"><button class="chip'+(SU.seg==='suppliers'?' on':'')+'" data-act="suSeg" data-v="suppliers">Suppliers</button><button class="chip'+(SU.seg==='purchases'?' on':'')+'" data-act="suSeg" data-v="purchases">Purchases</button></div>':'';
  if(SU.seg==='purchases'&&can('purchases.view')){
    $('#view').innerHTML=banner(S.detail.subscription)+'<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Purchases</h2><div class="mut">Stock bought from suppliers</div></div>'+(can('purchases.manage')?'<button class="btn sm" data-act="poForm">Record purchase</button>':'')+'</div>'+seg+'<div id="poList"><div class="empty"><span class="spin"></span></div></div></div>';
    guard(async()=>{const d=await api('/api/business/purchases?'+needBiz()+'&limit=60');SU.pl=d.purchases;
      $('#poList').innerHTML=d.purchases.length?d.purchases.map(p=>'<div class="row" data-act="poSheet" data-id="'+p.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(p.purchaseNo)+(p.status==='void'?' <span class="pill bad">VOID</span>':'')+'</div><div class="mut">'+dt(p.at)+' · '+esc(p.supplier||'No supplier')+(p.balanceDue>0?' · owe '+money(p.balanceDue):'')+'</div></div><b>'+money(p.total)+'</b></div>').join(''):'<div class="empty">No purchases yet.</div>'});
    return;
  }
  $('#view').innerHTML=banner(S.detail.subscription)+'<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Suppliers</h2><div class="mut" id="suSub"></div></div>'+(can('suppliers.manage')?'<button class="btn sm" data-act="suForm">Add supplier</button>':'')+'</div>'+seg+'<input id="su_search" placeholder="Search name or phone" value="'+esc(SU.search)+'"><div class="chips" style="margin-top:10px"><button class="chip'+(SU.owing?'':' on')+'" data-act="suOwing" data-v="0">All</button><button class="chip'+(SU.owing?' on':'')+'" data-act="suOwing" data-v="1">You owe</button></div><div id="suList" style="margin-top:10px"><div class="empty"><span class="spin"></span></div></div></div>';
  loadSuppliers();
}
function loadSuppliers(){guard(async()=>{
  const d=await api('/api/business/suppliers?'+needBiz()+'&limit=150&search='+encodeURIComponent(SU.search)+(SU.owing?'&owing=1':''));SU.list=d.suppliers;
  const sub=$('#suSub');if(sub)sub.textContent=d.totalOwed>0?'You owe suppliers '+money(d.totalOwed):'No unpaid supplier balances';
  const l=$('#suList');if(l)l.innerHTML=d.suppliers.length?d.suppliers.map(s=>'<div class="row" data-act="suSheet" data-id="'+s.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(s.name)+'</div><div class="mut">'+esc(s.phone||'No phone')+'</div></div>'+(s.balance>0?'<span class="pill warn">You owe '+money(s.balance)+'</span>':s.balance<0?'<span class="pill ok">Credit '+money(-s.balance)+'</span>':'')+'</div>').join(''):'<div class="empty">No suppliers yet.</div>';
})}
actions.suSeg=el=>{SU.seg=el.dataset.v;renderSuppliers()};
actions.suOwing=el=>{SU.owing=el.dataset.v==='1';renderSuppliers()};
actions.suForm=el=>{
  const c=el&&el.dataset&&el.dataset.edit&&SU.detail?SU.detail.supplier:null;
  sheet('<h2>'+(c?'Edit supplier':'Add supplier')+'</h2><label>NAME</label><input id="sf_name" maxlength="80" value="'+esc(c?c.name:'')+'"><label>PHONE</label><input id="sf_phone" inputmode="tel" maxlength="20" value="'+esc(c&&c.phone||'')+'"><label>EMAIL (OPTIONAL)</label><input id="sf_email" maxlength="120" value="'+esc(c&&c.email||'')+'"><label>ADDRESS (OPTIONAL)</label><input id="sf_addr" maxlength="200" value="'+esc(c&&c.address||'')+'"><label>NOTES (OPTIONAL)</label><input id="sf_notes" maxlength="300" value="'+esc(c&&c.notes||'')+'"><br><button class="btn block" data-act="suSave" data-id="'+(c?c.id:'')+'">Save supplier</button><br><button class="btn ghost block" data-act="close">Cancel</button>');
};
actions.suSave=async el=>{
  const g=x=>$('#'+x).value.trim();busy(el,true,'Saving…');
  try{const d=await api('/api/business/suppliers/save',{body:{businessId:S.bizId,id:el.dataset.id?Number(el.dataset.id):undefined,name:g('sf_name'),phone:g('sf_phone'),email:g('sf_email'),address:g('sf_addr'),notes:g('sf_notes')}});toast(d.message);closeSheet();if(S.tab==='suppliers')renderSuppliers()}
  catch(e){toast(e.message);busy(el,false)}
};
actions.suSheet=el=>guard(async()=>{
  const d=await api('/api/business/suppliers/detail?'+needBiz()+'&id='+el.dataset.id);SU.detail=d;const s=d.supplier,mg=can('suppliers.manage');SU.payIdem=uidk();
  sheet('<h2>'+esc(s.name)+'</h2><div class="mut">'+esc([s.phone,s.email].filter(Boolean).join(' · ')||'No contact details')+'</div><div class="stat" style="margin-top:12px"><span class="mut">'+(s.balance>0?'You owe':s.balance<0?'Supplier owes you':'Balance')+'</span><b>'+money(Math.abs(s.balance))+'</b></div>'+
    (mg&&s.balance>0?'<label>PAY SUPPLIER (₦)</label><div class="grid g2"><input id="sp_amt" inputmode="decimal" placeholder="'+s.balance+'" style="margin:0">'+methodSel('sp_method')+'</div><button class="btn block" style="margin-top:10px" data-act="suPay" data-id="'+s.id+'">Record payment</button>':'')+
    (can('purchases.manage')?'<br><button class="btn ghost block" data-act="poForm" data-sup="'+s.id+'">Record a purchase from this supplier</button>':'')+
    (d.ledger.length?'<h2 style="margin-top:16px">Account</h2>'+d.ledger.slice(0,12).map(l=>'<div class="row"><div class="grow"><div class="nm" style="text-transform:capitalize">'+esc(l.type.replace('_',' '))+(l.method?' · '+esc(l.method):'')+'</div><div class="mut">'+dt(l.at)+'</div></div><b style="color:var(--'+(l.amount>0?'warn':'ok')+')">'+(l.amount>0?'+':'−')+money(Math.abs(l.amount))+'</b></div>').join(''):'')+
    (d.purchases.length?'<h2 style="margin-top:16px">Purchases</h2>'+d.purchases.slice(0,8).map(p=>'<div class="row" data-act="poSheet" data-id="'+p.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(p.purchaseNo)+(p.status==='void'?' <span class="pill bad">VOID</span>':'')+'</div><div class="mut">'+dt(p.at)+'</div></div><b>'+money(p.total)+'</b></div>').join(''):'')+
    '<br>'+(mg?'<button class="btn ghost block" data-act="suForm" data-edit="1">Edit details</button><br>':'')+'<button class="btn ghost block" data-act="close">Close</button>');
});
actions.suPay=async el=>{
  busy(el,true,'Saving…');
  try{const d=await api('/api/business/suppliers/payment',{body:{businessId:S.bizId,supplierId:Number(el.dataset.id),amount:num($('#sp_amt').value),method:$('#sp_method').value,idempotencyKey:SU.payIdem}});toast(d.message);closeSheet();if(S.tab==='suppliers')renderSuppliers()}
  catch(e){toast(e.message);busy(el,false)}
};
/* purchase form */
actions.poForm=el=>guard(async()=>{
  const supId=el&&el.dataset&&el.dataset.sup?Number(el.dataset.sup):null;
  const [pr,sp]=await Promise.all([api('/api/business/products?'+needBiz()+'&limit=200'),api('/api/business/suppliers?'+needBiz()+'&limit=200')]);
  PO={rows:[{name:'',qty:'',cost:'',pid:null}],prods:pr.products.filter(p=>p.trackStock),map:{},idem:uidk(),suppliers:sp.suppliers,paid:'',update:false};
  PO.prods.forEach(p=>{PO.map[p.name+(p.sku?' · '+p.sku:'')]=p});
  if(!PO.prods.length){toast('Add products first (Stock tab), then record purchases.');return}
  const bs=activeBranches();
  sheet('<h2>Record purchase</h2><div class="mut">Adds the goods to your stock. Pay now, or owe the supplier.</div>'+
    (bs.length>1?'<label>RECEIVED AT</label><select class="f" id="po_branch">'+bs.map(b=>'<option value="'+b.id+'">'+esc(b.name)+'</option>').join('')+'</select>':'')+
    '<label>SUPPLIER</label><select class="f" id="po_sup"><option value="">No supplier (paid in full)</option>'+PO.suppliers.map(s=>'<option value="'+s.id+'"'+(s.id===supId?' selected':'')+'>'+esc(s.name)+'</option>').join('')+'</select>'+
    '<label>SUPPLIER INVOICE NO. (OPTIONAL)</label><input id="po_ref" maxlength="60"><label>ITEMS</label><datalist id="po_prods">'+Object.keys(PO.map).map(k=>'<option value="'+esc(k)+'">').join('')+'</datalist><div id="poRows"></div><button class="btn ghost sm" data-act="poAdd" style="margin-top:8px">+ Add item</button>'+
    '<div class="chk" style="margin-top:12px"><label><input type="checkbox" id="po_upd"> Update product cost prices to these costs</label></div><div class="sum" id="poTot"></div>'+
    '<label>PAID NOW (₦)</label><div class="grid g2"><input id="po_paid" data-ph3="po_paid" inputmode="decimal" placeholder="0" style="margin:0">'+methodSel('po_method')+'</div><button class="btn ghost sm" data-act="poFull" style="margin-top:8px">Pay in full</button>'+
    '<br><br><button class="btn block" id="poSave" data-act="poSave">Save purchase</button><br><button class="btn ghost block" data-act="close">Cancel</button>');
  drawPoRows();
});
function drawPoRows(){
  const box=$('#poRows');if(!box)return;
  box.innerHTML=PO.rows.map((r,i)=>'<div class="row" style="align-items:flex-start;gap:6px"><div class="grow"><input list="po_prods" data-ph3="po_name" data-i="'+i+'" value="'+esc(r.name)+'" placeholder="Choose product" style="margin-bottom:6px"><div class="grid g2"><input data-ph3="po_qty" data-i="'+i+'" value="'+esc(r.qty)+'" inputmode="decimal" placeholder="Quantity" style="margin:0"><input data-ph3="po_cost" data-i="'+i+'" value="'+esc(r.cost)+'" inputmode="decimal" placeholder="Cost each (₦)" style="margin:0"></div>'+(BM.feat('advanced_inventory')?'<div class="grid g2" style="margin-top:6px"><input type="date" data-ph3="po_exp" data-i="'+i+'" value="'+esc(r.expiry||'')+'" aria-label="Expiry date" style="margin:0"><input data-ph3="po_lot" data-i="'+i+'" value="'+esc(r.lot||'')+'" placeholder="Lot no. (optional)" maxlength="40" style="margin:0"></div>':'')+'</div><button class="x" data-act="poRm" data-i="'+i+'" aria-label="Remove">✕</button></div>').join('');
  poTotals();
}
function poTotal(){return PO.rows.reduce((a,r)=>a+Math.round(Math.round(num(r.cost)*100)*num(r.qty)),0)}
function poTotals(){
  const t=poTotal(),paid=Math.round(num(PO.paid)*100),b=$('#poTot');if(!b)return;
  b.innerHTML='<div class="tot"><span>Total</span><span>'+m2(t/100)+'</span></div><div><span class="mut">Paid now</span><span>'+m2(Math.min(paid,t)/100)+'</span></div>'+(t>paid?'<div style="color:var(--warn)"><span>You will owe</span><b>'+m2((t-paid)/100)+'</b></div>':'')+(paid>t?'<div style="color:var(--bad)"><span>Paid is more than the total</span></div>':'');
}
actions.poAdd=()=>{PO.rows.push({name:'',qty:'',cost:'',pid:null});drawPoRows()};
actions.poRm=el=>{if(PO.rows.length>1){PO.rows.splice(Number(el.dataset.i),1);drawPoRows()}};
actions.poFull=()=>{PO.paid=String(poTotal()/100);const e=$('#po_paid');if(e)e.value=PO.paid;poTotals()};
actions.poSave=async el=>{
  const items=[];
  for(const r of PO.rows){const p=PO.map[r.name];if(!p){toast('Choose each product from the list');return}items.push({productId:p.id,qty:num(r.qty),unitCost:num(r.cost),expiry:r.expiry||undefined,lotNo:r.lot||undefined})}
  const sup=$('#po_sup').value;
  busy(el,true,'Saving…');
  try{const d=await api('/api/business/purchases/create',{body:{businessId:S.bizId,branchId:$('#po_branch')?Number($('#po_branch').value):activeBranches()[0].id,supplierId:sup?Number(sup):undefined,reference:$('#po_ref').value.trim(),items,paid:num(PO.paid),method:$('#po_method').value,updateCost:$('#po_upd').checked,idempotencyKey:PO.idem}});
    toast(d.message);closeSheet();if(S.tab==='suppliers')renderSuppliers()}
  catch(e){toast(e.message);busy(el,false)}
};
actions.poSheet=el=>guard(async()=>{
  const d=await api('/api/business/purchases/detail?'+needBiz()+'&id='+el.dataset.id),p=d.purchase;
  sheet('<h2>'+esc(p.purchaseNo)+(p.status==='void'?' · Voided':'')+'</h2><div class="mut">'+dt(p.createdAt)+' · '+esc(p.branch)+(p.supplier?' · '+esc(p.supplier):'')+(p.reference?' · Ref '+esc(p.reference):'')+'</div><div style="margin-top:10px">'+
    p.items.map(i=>'<div class="row"><div class="grow"><div class="nm">'+esc(i.name)+'</div><div class="mut">'+i.qty+' × '+m2(i.unitCost)+'</div></div><b>'+m2(i.lineTotal)+'</b></div>').join('')+'</div><div class="sum"><div class="tot"><span>Total</span><span>'+m2(p.total)+'</span></div><div><span class="mut">Paid</span><span>'+m2(p.paid)+(p.payMethod?' ('+esc(p.payMethod)+')':'')+'</span></div>'+(p.balanceDue>0?'<div style="color:var(--warn)"><span>Owed to supplier</span><b>'+m2(p.balanceDue)+'</b></div>':'')+'</div>'+
    (p.status==='void'?'<div class="banner bad" style="margin-top:12px">Voided: '+esc(p.voidReason||'')+'</div>':'')+'<br>'+(d.canManage&&p.status==='received'?'<button class="btn bad block" data-act="poVoid" data-id="'+p.id+'">Void this purchase</button><br>':'')+'<button class="btn ghost block" data-act="close">Close</button>');
});
actions.poVoid=async el=>{
  const reason=prompt('Why are you voiding this purchase? (required)');if(!reason||reason.trim().length<3||!confirm('Void this purchase? The stock will be removed again.'))return;
  guard(async()=>{const d=await api('/api/business/purchases/void',{body:{businessId:S.bizId,purchaseId:Number(el.dataset.id),reason:reason.trim()}});toast(d.message);closeSheet();if(S.tab==='suppliers')renderSuppliers()});
};

/* ================= Invoices ================= */
let IV={status:'',search:'',list:[],meta:{},form:null,idem:null};
const ICSS='.idoc{background:#fff;color:#111;font:13px/1.45 Inter,Arial,sans-serif;padding:18px;border-radius:12px}.idoc .ih{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.idoc .ib{font-size:16px;font-weight:800}.idoc .ititle{font-size:22px;font-weight:900;letter-spacing:.06em;color:#8a6a00}.idoc .r{text-align:right}.idoc table{width:100%;border-collapse:collapse;margin:14px 0}.idoc th{font-size:11px;letter-spacing:.06em;text-align:left;border-bottom:2px solid #111;padding:6px 4px}.idoc td{padding:7px 4px;border-bottom:1px solid #ddd;vertical-align:top}.idoc td.n,.idoc th.n{text-align:right;white-space:nowrap}.idoc .tt{margin-left:auto;width:min(260px,100%)}.idoc .tt div{display:flex;justify-content:space-between;padding:3px 0}.idoc .tt .g{font-weight:900;font-size:15px;border-top:2px solid #111;margin-top:4px;padding-top:6px}.idoc .stamp{display:inline-block;border:2px solid;border-radius:6px;padding:2px 8px;font-weight:900;letter-spacing:.08em;transform:rotate(-4deg);margin-top:6px}.idoc .mutd{color:#666;font-size:12px}.idoc .bt{margin-top:12px;white-space:pre-wrap}';
{const st=document.createElement('style');st.textContent=ICSS+'.bar1{height:6px;border-radius:99px;background:var(--card2);overflow:hidden}.bar1 i{display:block;height:100%;background:linear-gradient(90deg,var(--gold2),var(--gold));border-radius:99px}.hero{border-radius:22px;padding:20px;background:linear-gradient(135deg,var(--card2),var(--card));border:1px solid var(--line);margin-bottom:14px}.hero b{display:block;font-size:30px;margin:4px 0}.tbl .row{padding:9px 0}.tbl .sub{padding-left:14px;color:var(--mut);font-size:13px}.tbl .hl{font-weight:800;border-top:2px solid var(--line)}.pos-t{color:var(--ok)}.neg-t{color:var(--bad)}svg.chart{width:100%;height:150px;display:block}';document.head.appendChild(st)}
const statusPill=i=>{const m={draft:['','Draft'],unpaid:['warn','Unpaid'],partial:['warn','Part paid'],paid:['ok','Paid'],void:['bad','Void']};const x=m[i.status]||['',i.status];return '<span class="pill '+x[0]+'">'+x[1]+'</span>'+(i.overdue?' <span class="pill bad">Overdue</span>':'')};
function renderInvoices(){
  const chips=[['','All'],['unpaid','Unpaid'],['overdue','Overdue'],['partial','Part paid'],['paid','Paid'],['draft','Drafts']];
  $('#view').innerHTML=banner(S.detail.subscription)+'<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Invoices</h2><div class="mut" id="ivSub"></div></div>'+(can('invoices.manage')?'<button class="btn sm" data-act="ivForm">New invoice</button>':'')+'</div><input id="iv_search" placeholder="Search invoice number or customer" value="'+esc(IV.search)+'"><div class="chips" style="margin-top:10px;overflow-x:auto;white-space:nowrap">'+chips.map(c=>'<button class="chip'+(IV.status===c[0]?' on':'')+'" data-act="ivStatus" data-v="'+c[0]+'">'+c[1]+'</button>').join('')+'</div><div id="ivList" style="margin-top:10px"><div class="empty"><span class="spin"></span></div></div></div>';
  loadInvoices();
}
function loadInvoices(){guard(async()=>{
  const d=await api('/api/business/invoices?'+needBiz()+'&limit=80&search='+encodeURIComponent(IV.search)+(IV.status?'&status='+IV.status:''));IV.list=d.invoices;IV.meta=d;
  const sub=$('#ivSub');if(sub)sub.textContent=d.outstanding>0?'Unpaid: '+money(d.outstanding)+(d.overdue>0?' · overdue '+money(d.overdue):''):'Nothing outstanding';
  const l=$('#ivList');if(l)l.innerHTML=d.invoices.length?d.invoices.map(i=>'<div class="row" data-act="ivSheet" data-id="'+i.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(i.invoiceNo||'Draft')+' · '+esc(i.customerName)+'</div><div class="mut">Due '+dt(i.dueDate)+' '+statusPill(i)+'</div></div><div style="text-align:right"><b>'+money(i.total)+'</b>'+(i.balanceDue>0&&i.paid>0?'<div class="mut">'+money(i.balanceDue)+' left</div>':'')+'</div></div>').join(''):'<div class="empty">No invoices here yet.</div>';
})}
actions.ivStatus=el=>{IV.status=el.dataset.v;renderInvoices()};
function invoiceDoc(inv,b){
  const stamp=inv.status==='paid'?'<div class="stamp" style="color:#1f8a4c">PAID</div>':inv.status==='void'?'<div class="stamp" style="color:#c0392b">VOID</div>':inv.status==='draft'?'<div class="stamp" style="color:#888">DRAFT</div>':'';
  return '<div class="idoc"><div class="ih"><div><div class="ib">'+esc(b.name)+'</div><div class="mutd">'+[b.address,b.phone,b.email,b.tin?'TIN: '+b.tin:''].filter(Boolean).map(esc).join('<br>')+'</div></div><div class="r"><div class="ititle">INVOICE</div><div><b>'+esc(inv.invoiceNo||'DRAFT')+'</b></div><div class="mutd">Issued '+dt(inv.issueDate)+'<br>Due '+dt(inv.dueDate)+'</div>'+stamp+'</div></div>'+
    '<div style="margin-top:14px"><div class="mutd">BILL TO</div><b>'+esc(inv.customerName)+'</b><div class="mutd">'+[inv.customerPhone,inv.customerEmail].filter(Boolean).map(esc).join(' · ')+'</div></div>'+
    '<table><thead><tr><th>DESCRIPTION</th><th class="n">QTY</th><th class="n">PRICE</th><th class="n">AMOUNT</th></tr></thead><tbody>'+inv.items.map(i=>'<tr><td>'+esc(i.description)+'</td><td class="n">'+i.qty+'</td><td class="n">'+m2(i.unitPrice)+'</td><td class="n">'+m2(i.lineTotal)+'</td></tr>').join('')+'</tbody></table>'+
    '<div class="tt"><div><span>Subtotal</span><span>'+m2(inv.subtotal)+'</span></div>'+(inv.discount>0?'<div><span>Discount</span><span>−'+m2(inv.discount)+'</span></div>':'')+(inv.vatRate>0?'<div><span>VAT '+inv.vatRate+'%'+(inv.vatInclusive?' (incl.)':'')+'</span><span>'+m2(inv.tax)+'</span></div>':'')+'<div class="g"><span>Total</span><span>'+m2(inv.total)+'</span></div>'+(inv.paid>0?'<div><span>Paid</span><span>−'+m2(inv.paid)+'</span></div><div class="g"><span>Balance due</span><span>'+m2(inv.balanceDue)+'</span></div>':'')+'</div>'+
    (inv.notes?'<div class="bt"><b>Notes</b><br>'+esc(inv.notes)+'</div>':'')+(inv.terms?'<div class="bt"><b>Terms</b><br>'+esc(inv.terms)+'</div>':'')+'<div class="mutd" style="margin-top:16px;text-align:center">Powered by BOLTIV</div></div>';
}
function invoiceText(inv,b){return b.name+'\nInvoice '+(inv.invoiceNo||'')+'\nAmount: '+m2(inv.total)+(inv.paid>0?'\nBalance due: '+m2(inv.balanceDue):'')+'\nDue: '+dt(inv.dueDate)+'\n\nThank you for your business.'}
function waNum(p){const d=String(p||'').replace(/\D/g,'');return d.startsWith('234')&&d.length===13?d:d.startsWith('0')&&d.length===11?'234'+d.slice(1):''}
actions.ivSheet=el=>guard(async()=>{
  const d=await api('/api/business/invoices/detail?'+needBiz()+'&id='+el.dataset.id),inv=d.invoice;IV.cur=d;IV.payIdem=uidk();
  const mg=d.canManage,pay=mg&&inv.status==='paid'?'':(mg&&inv.rawStatus==='issued'&&inv.balanceDue>0);
  sheet('<div class="docprev" id="docPrev">'+(window.BDOC?BDOC.WAIT:'')+'</div>'+(pay?'<label>RECORD A PAYMENT</label><div class="grid g2"><input id="ip_amt" inputmode="decimal" value="'+inv.balanceDue+'" style="margin:0">'+methodSel('ip_method')+'</div><div class="grid g2" style="margin-top:8px"><input type="date" id="ip_date" value="'+todayStr()+'" max="'+todayStr()+'" style="margin:0"><input id="ip_note" placeholder="Note (optional)" maxlength="200" style="margin:0"></div><button class="btn block" style="margin-top:10px" data-act="ivPay" data-id="'+inv.id+'">Record payment</button>':'')+
    (inv.payments&&inv.payments.length?'<h2 style="margin-top:14px">Payments</h2>'+inv.payments.map(p=>'<div class="row"><div class="grow"><div class="nm">'+m2(p.amount)+(p.status==='void'?' <span class="pill bad">REMOVED</span>':'')+'</div><div class="mut">'+dt(p.date)+' · '+esc(p.method)+(p.note?' · '+esc(p.note):'')+'</div></div>'+(mg&&p.status==='active'&&inv.rawStatus==='issued'?'<button class="btn ghost sm" data-act="ivPayVoid" data-id="'+p.id+'">Remove</button>':'')+'</div>').join(''):'')+
    '<div class="grid g2" style="margin-top:14px"><button class="btn" data-act="shareDoc">Share on WhatsApp</button><button class="btn ghost" data-act="saveDoc">Save picture</button></div><button class="btn ghost block" style="margin-top:10px" data-act="ivPrint">Print / Save PDF</button>'+
    (mg&&inv.rawStatus==='draft'?'<br><button class="btn block" data-act="ivIssue" data-id="'+inv.id+'">Issue invoice</button><br><button class="btn ghost block" data-act="ivForm" data-id="'+inv.id+'">Edit draft</button>':'')+
    (mg&&inv.rawStatus!=='void'?'<br><button class="btn bad block" data-act="ivVoid" data-id="'+inv.id+'">Void invoice</button>':'')+'<br><button class="btn ghost block" data-act="close">Close</button>');
  if(window.BDOC)BDOC.mount('invoice',inv,d.business,{name:'Invoice-'+String(inv.invoiceNo||'draft').replace(/[^\w.-]+/g,'-')+'.png',text:invoiceText(inv,d.business),phone:waNum(inv.customerPhone)});
});
actions.ivPrint=()=>{
  if(!IV.cur)return;const f=document.createElement('iframe');f.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0';document.body.appendChild(f);
  const d=f.contentWindow.document;d.open();d.write('<!doctype html><html><head><meta charset="utf-8"><title>'+esc(IV.cur.invoice.invoiceNo||'Invoice')+'</title><style>@page{margin:14mm}body{margin:0}'+ICSS+'.idoc{padding:0}</style></head><body>'+invoiceDoc(IV.cur.invoice,IV.cur.business)+'</body></html>');d.close();
  setTimeout(()=>{try{f.contentWindow.focus();f.contentWindow.print()}catch(e){}setTimeout(()=>f.remove(),2000)},250);
};
actions.ivPay=async el=>{
  busy(el,true,'Saving…');
  try{const d=await api('/api/business/invoices/payment',{body:{businessId:S.bizId,invoiceId:Number(el.dataset.id),amount:num($('#ip_amt').value),method:$('#ip_method').value,date:$('#ip_date').value,note:$('#ip_note').value,idempotencyKey:IV.payIdem}});toast(d.message);closeSheet();if(S.tab==='invoices')loadInvoices()}
  catch(e){toast(e.message);busy(el,false)}
};
actions.ivPayVoid=async el=>{
  const reason=prompt('Why are you removing this payment? (required)');if(!reason||reason.trim().length<3)return;
  guard(async()=>{const d=await api('/api/business/invoices/payment/void',{body:{businessId:S.bizId,paymentId:Number(el.dataset.id),reason:reason.trim()}});toast(d.message);closeSheet();if(S.tab==='invoices')loadInvoices()});
};
actions.ivIssue=async el=>{if(!confirm('Issue this invoice? You will not be able to edit it afterwards.'))return;guard(async()=>{const d=await api('/api/business/invoices/issue',{body:{businessId:S.bizId,invoiceId:Number(el.dataset.id)}});toast(d.message);closeSheet();loadInvoices()})};
actions.ivVoid=async el=>{
  const reason=prompt('Why are you voiding this invoice? (required)');if(!reason||reason.trim().length<3||!confirm('Void this invoice?'))return;
  guard(async()=>{const d=await api('/api/business/invoices/void',{body:{businessId:S.bizId,invoiceId:Number(el.dataset.id),reason:reason.trim()}});toast(d.message);closeSheet();if(S.tab==='invoices')loadInvoices()});
};
/* invoice form */
actions.ivForm=el=>guard(async()=>{
  const id=el&&el.dataset&&el.dataset.id?Number(el.dataset.id):null;let cur=null;
  if(id){const d=await api('/api/business/invoices/detail?'+needBiz()+'&id='+id);cur=d.invoice}
  IV.form={id,custId:cur?cur.customerId:null,items:cur?cur.items.map(i=>({description:i.description,qty:String(i.qty),price:String(i.unitPrice)})):[{description:'',qty:'1',price:''}],discount:cur&&cur.discount?String(cur.discount):''};
  IV.idem=uidk();
  const bs=activeBranches(),restricted=!can('business.edit')&&bs.length>1;
  sheet('<h2>'+(id?'Edit draft':'New invoice')+'</h2><label>CUSTOMER NAME</label><input id="if_name" maxlength="80" value="'+esc(cur?cur.customerName:'')+'" autocomplete="off"><button class="btn ghost sm" data-act="ivPick" style="margin-top:8px">Choose from my customers</button>'+
    '<div class="grid g2"><div><label>PHONE</label><input id="if_phone" inputmode="tel" maxlength="20" value="'+esc(cur&&cur.customerPhone||'')+'"></div><div><label>EMAIL</label><input id="if_email" maxlength="120" value="'+esc(cur&&cur.customerEmail||'')+'"></div></div>'+
    '<div class="grid g2"><div><label>ISSUE DATE</label><input type="date" id="if_issue" value="'+(cur?cur.issueDate:todayStr())+'"></div><div><label>DUE DATE</label><input type="date" id="if_due" value="'+(cur?cur.dueDate:addD(todayStr(),14))+'"></div></div>'+
    (bs.length>1?'<label>BRANCH</label><select class="f" id="if_branch">'+(restricted?'':'<option value="">Whole business</option>')+bs.map(b=>'<option value="'+b.id+'"'+(cur&&cur.branchId===b.id?' selected':'')+'>'+esc(b.name)+'</option>').join('')+'</select>':'')+
    '<label>ITEMS</label><div id="ifRows"></div><button class="btn ghost sm" data-act="ivAddRow" style="margin-top:8px">+ Add item</button><label>DISCOUNT (₦)</label><input data-ph3="if_disc" inputmode="decimal" value="'+esc(IV.form.discount)+'" placeholder="0"><div class="sum" id="ifTot"></div>'+
    '<label>NOTES (OPTIONAL)</label><input id="if_notes" maxlength="500" value="'+esc(cur&&cur.notes||'')+'" placeholder="e.g. Bank details for transfer"><label>TERMS (OPTIONAL)</label><input id="if_terms" maxlength="500" value="'+esc(cur&&cur.terms||'')+'" placeholder="e.g. Payment due within 14 days">'+
    '<br><button class="btn block" data-act="ivSave" data-issue="1">'+(id?'Save and issue':'Issue invoice')+'</button><br><button class="btn ghost block" data-act="ivSave" data-issue="0">Save as draft</button><br><button class="btn ghost block" data-act="close">Cancel</button>');
  drawIfRows();
});
function drawIfRows(){
  const box=$('#ifRows');if(!box)return;
  box.innerHTML=IV.form.items.map((r,i)=>'<div class="row" style="align-items:flex-start;gap:6px"><div class="grow"><input data-ph3="if_desc" data-i="'+i+'" value="'+esc(r.description)+'" placeholder="Description" maxlength="200" style="margin-bottom:6px"><div class="grid g2"><input data-ph3="if_qty" data-i="'+i+'" value="'+esc(r.qty)+'" inputmode="decimal" placeholder="Qty" style="margin:0"><input data-ph3="if_price" data-i="'+i+'" value="'+esc(r.price)+'" inputmode="decimal" placeholder="Price (₦)" style="margin:0"></div></div><button class="x" data-act="ivRmRow" data-i="'+i+'" aria-label="Remove">✕</button></div>').join('');
  ifTotals();
}
function ifCalc(){
  const b=S.detail.business,rate=b.vatRate||0,inc=b.vatInclusive;let sub=0;
  IV.form.items.forEach(r=>{sub+=Math.round(Math.round(num(r.price)*100)*num(r.qty))});
  const disc=Math.min(sub,Math.max(0,Math.round(num(IV.form.discount)*100))),tx=sub-disc;let tax=0,total=tx;
  if(rate>0){if(inc)tax=tx-Math.round(tx/(1+rate/100));else{tax=Math.round(tx*rate/100);total=tx+tax}}
  return {sub,disc,tax,total,rate,inc};
}
function ifTotals(){
  const t=ifCalc(),b=$('#ifTot');if(!b)return;
  b.innerHTML='<div><span>Subtotal</span><span>'+m2(t.sub/100)+'</span></div>'+(t.disc?'<div style="color:var(--ok)"><span>Discount</span><span>−'+m2(t.disc/100)+'</span></div>':'')+(t.rate>0?'<div><span>VAT '+t.rate+'%'+(t.inc?' (included)':'')+'</span><span>'+m2(t.tax/100)+'</span></div>':'')+'<div class="tot"><span>Total</span><span>'+m2(t.total/100)+'</span></div>';
}
actions.ivAddRow=()=>{IV.form.items.push({description:'',qty:'1',price:''});drawIfRows()};
actions.ivRmRow=el=>{if(IV.form.items.length>1){IV.form.items.splice(Number(el.dataset.i),1);drawIfRows()}};
actions.ivPick=()=>guard(async()=>{
  const d=await api('/api/business/customers?'+needBiz()+'&limit=100');
  const keep={name:$('#if_name').value,phone:$('#if_phone').value,email:$('#if_email').value};IV.keep=keep;IV.pickList=d.customers;
  const box=document.createElement('div');box.id='ivPickBox';box.className='card';box.style.margin='10px 0';
  box.innerHTML='<h2>Customers</h2>'+(d.customers.length?d.customers.map(c=>'<div class="row" data-act="ivChoose" data-id="'+c.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(c.name)+'</div><div class="mut">'+esc(c.phone||'')+'</div></div></div>').join(''):'<div class="empty">No customers yet. Just type the name above.</div>');
  const old=$('#ivPickBox');if(old)old.remove();$('#if_name').insertAdjacentElement('afterend',box);
});
actions.ivChoose=el=>{const c=(IV.pickList||[]).find(x=>x.id===Number(el.dataset.id));if(!c)return;IV.form.custId=c.id;$('#if_name').value=c.name;$('#if_phone').value=c.phone||'';$('#if_email').value=c.email||'';const b=$('#ivPickBox');if(b)b.remove()};
actions.ivSave=async el=>{
  const f=IV.form,g=x=>$('#'+x).value.trim(),issue=el.dataset.issue==='1';
  busy(el,true,'Saving…');
  try{const d=await api('/api/business/invoices/save',{body:{businessId:S.bizId,id:f.id||undefined,customerId:f.custId||undefined,customerName:g('if_name'),customerPhone:g('if_phone'),customerEmail:g('if_email'),issueDate:g('if_issue'),dueDate:g('if_due'),branchId:$('#if_branch')?$('#if_branch').value:undefined,
    items:f.items.map(r=>({description:r.description,qty:num(r.qty),unitPrice:num(r.price)})),discount:num(f.discount),notes:g('if_notes'),terms:g('if_terms'),issue,idempotencyKey:f.id?undefined:IV.idem}});
    toast(d.message);closeSheet();if(S.tab==='invoices')loadInvoices()}
  catch(e){toast(e.message);busy(el,false)}
};

/* ================= Finance ================= */
let FN={preset:'month',from:'',to:'',branch:'',data:null};
function fnRange(){
  const t=todayStr(),m=t.slice(0,7);
  if(FN.preset==='month')return monthRange(m);
  if(FN.preset==='last'){const d=new Date(t+'T00:00:00');d.setDate(1);d.setMonth(d.getMonth()-1);return monthRange(d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'))}
  if(FN.preset==='year')return {from:t.slice(0,4)+'-01-01',to:t};
  return {from:FN.from||monthRange(m).from,to:FN.to||t};
}
function renderFinance(){
  const chips=[['month','This month'],['last','Last month'],['year','This year'],['custom','Custom']],r=fnRange();
  $('#view').innerHTML='<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Financial records</h2><div class="mut" id="fnSub"></div></div><button class="btn ghost sm" data-act="fnExport">Export CSV</button></div><div class="chips" style="overflow-x:auto;white-space:nowrap">'+chips.map(c=>'<button class="chip'+(FN.preset===c[0]?' on':'')+'" data-act="fnPreset" data-v="'+c[0]+'">'+c[1]+'</button>').join('')+'</div>'+
    (FN.preset==='custom'?'<div class="grid g2" style="margin-top:10px"><input type="date" id="fn_from" value="'+r.from+'" max="'+todayStr()+'"><input type="date" id="fn_to" value="'+r.to+'" max="'+todayStr()+'"></div>':'')+'<div style="margin-top:10px">'+branchSel('fn_branch',FN.branch,true)+'</div></div><div id="fnBody"><div class="empty"><span class="spin"></span></div></div>';
  loadFinance();
}
function weekly(days){
  if(days.length<=45)return days.map(d=>({label:d.day.slice(5),revenue:d.revenue,expenses:d.expenses}));
  const m=new Map();
  days.forEach(d=>{const t=new Date(d.day+'T00:00:00');const k=addD(d.day,-((t.getDay()+6)%7));const x=m.get(k)||{label:k.slice(5),revenue:0,expenses:0};x.revenue+=d.revenue;x.expenses+=d.expenses;m.set(k,x)});
  return [...m.values()];
}
function chartSvg(days){
  const pts=weekly(days);if(!pts.length)return '<div class="empty">No activity in this period.</div>';
  const W=320,H=130,max=Math.max(1,...pts.map(p=>Math.max(p.revenue,p.expenses))),bw=Math.max(3,Math.min(18,(W-10)/pts.length/2-2));
  return '<svg class="chart" viewBox="0 0 '+W+' '+(H+18)+'" preserveAspectRatio="none" role="img" aria-label="Revenue and expenses by day">'+pts.map((p,i)=>{const x=6+i*((W-12)/pts.length),h1=Math.round(p.revenue/max*H),h2=Math.round(p.expenses/max*H);return '<rect x="'+x.toFixed(1)+'" y="'+(H-h1)+'" width="'+bw+'" height="'+h1+'" rx="2" fill="var(--gold)"/><rect x="'+(x+bw+1).toFixed(1)+'" y="'+(H-h2)+'" width="'+bw+'" height="'+h2+'" rx="2" fill="var(--bad)" opacity=".75"/>'}).join('')+'</svg><div class="mut" style="display:flex;gap:14px;font-size:12px"><span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--gold)"></i> Revenue</span><span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--bad)"></i> Expenses</span></div>';
}
function loadFinance(){guard(async()=>{
  const r=fnRange(),box=$('#fnBody'),money=m2;
  try{
    const d=await api('/api/business/finance/summary?'+needBiz()+'&from='+r.from+'&to='+r.to+(FN.branch?'&branch_id='+FN.branch:''));FN.data=d;const p=d.pnl,pos=d.position;
    const sub=$('#fnSub');if(sub)sub.textContent=dt(d.range.from)+' – '+dt(d.range.to);
    const row=(l,v,cls,c2)=>'<div class="row '+(c2||'')+'"><div class="grow">'+l+'</div><b class="'+(cls||'')+'">'+v+'</b></div>';
    const maxE=Math.max(1,...d.expensesByCategory.map(x=>x.amount));
    box.innerHTML='<div class="hero"><span class="mut">Net profit</span><b class="'+(p.netProfit>=0?'pos-t':'neg-t')+'">'+(p.netProfit<0?'−':'')+money(Math.abs(p.netProfit))+'</b><span class="mut">'+(p.revenue>0?p.marginPct+'% of revenue':'No revenue in this period')+'</span></div>'+
      '<div class="card tbl"><h2>Profit &amp; loss</h2>'+row('Revenue (before VAT)',money(p.revenue))+(d.revenueParts.invoices>0?'<div class="row sub"><div class="grow">Sales ('+d.counts.sales+')</div><span>'+money(d.revenueParts.sales)+'</span></div><div class="row sub"><div class="grow">Invoices ('+d.counts.invoices+')</div><span>'+money(d.revenueParts.invoices)+'</span></div>':'')+row('Cost of goods sold','−'+money(p.cogs))+row('Gross profit',money(p.grossProfit),'','hl')+row('Expenses','−'+money(p.expenses))+
      d.expensesByCategory.slice(0,8).map(x=>'<div class="sub" style="padding:4px 0 4px 14px"><div class="row" style="border:0;padding:0"><div class="grow">'+esc(x.category)+'</div><span>'+money(x.amount)+'</span></div><div class="bar1" style="margin-top:3px"><i style="width:'+Math.max(3,Math.round(x.amount/maxE*100))+'%"></i></div></div>').join('')+
      row('Net profit',(p.netProfit<0?'−':'')+money(Math.abs(p.netProfit)),p.netProfit>=0?'pos-t':'neg-t','hl')+'<div class="mut" style="margin-top:8px">VAT collected in this period: '+money(p.vatCollected)+' (not included above). Cost of goods uses the cost price saved on each product at the time of sale.</div></div>'+
      '<div class="card tbl"><h2>Money in and out</h2><div class="mut">What actually moved, by the date it was paid.</div>'+row('Money in',money(p.cashIn),'pos-t')+Object.entries(d.cash.inByMethod).map(([k,v])=>'<div class="row sub"><div class="grow" style="text-transform:capitalize">Sales · '+esc(k)+'</div><span>'+money(v)+'</span></div>').join('')+(d.cash.customerPayments>0?'<div class="row sub"><div class="grow">Customer debt payments</div><span>'+money(d.cash.customerPayments)+'</span></div>':'')+(d.cash.invoicePayments>0?'<div class="row sub"><div class="grow">Invoice payments</div><span>'+money(d.cash.invoicePayments)+'</span></div>':'')+
      row('Money out','−'+money(p.cashOut),'neg-t')+'<div class="row sub"><div class="grow">Expenses</div><span>'+money(d.cash.out.expenses)+'</span></div><div class="row sub"><div class="grow">Stock purchases paid</div><span>'+money(d.cash.out.purchases)+'</span></div><div class="row sub"><div class="grow">Supplier payments</div><span>'+money(d.cash.out.supplierPayments)+'</span></div>'+row('Net cash',(p.netCash<0?'−':'')+money(Math.abs(p.netCash)),p.netCash>=0?'pos-t':'neg-t','hl')+'</div>'+
      '<div class="card tbl"><h2>Where you stand today</h2><div class="mut">As of now, across the whole business.</div>'+row('Customers owe you',money(pos.customersOwe))+row('Unpaid invoices',money(pos.invoicesOutstanding))+row('You owe suppliers',money(pos.youOweSuppliers))+row('Stock value (at cost)'+(d.branchFiltered?' · this branch':''),money(pos.inventoryValue))+'</div>'+
      '<div class="card"><h2>Revenue and expenses</h2>'+chartSvg(d.byDay)+'</div>';
  }catch(e){box.innerHTML='<div class="card empty">'+esc(e.message)+'</div>'}
})}
actions.fnPreset=el=>{FN.preset=el.dataset.v;if(FN.preset==='custom'){const r=fnRange();FN.from=r.from;FN.to=r.to}renderFinance()};
actions.fnExport=()=>{
  const d=FN.data;if(!d){toast('Nothing to export yet');return}const p=d.pnl;
  const rows=[['BOLTIV Business Manager',S.detail.business.name],['Period',d.range.from+' to '+d.range.to],[],['PROFIT AND LOSS',''],['Revenue (before VAT)',p.revenue],['Cost of goods sold',p.cogs],['Gross profit',p.grossProfit],['Expenses',p.expenses],['Net profit',p.netProfit],['VAT collected',p.vatCollected],[],['EXPENSES BY CATEGORY','Amount']]
    .concat(d.expensesByCategory.map(x=>[x.category,x.amount]),[[],['MONEY','Amount'],['Money in',p.cashIn],['Money out',p.cashOut],['Net cash',p.netCash],[],['POSITION','Amount'],['Customers owe you',d.position.customersOwe],['Unpaid invoices',d.position.invoicesOutstanding],['You owe suppliers',d.position.youOweSuppliers],['Stock value at cost',d.position.inventoryValue],[],['DAILY','Revenue','Expenses']],d.byDay.map(x=>[x.day,x.revenue,x.expenses]));
  download('boltiv-finance-'+d.range.from+'-to-'+d.range.to+'.csv',rows);
};

/* ================= input handling ================= */
const poSearchFill=(i,name)=>{const p=PO.map[name];PO.rows[i].pid=p?p.id:null;if(p&&!PO.rows[i].cost&&p.costPrice)PO.rows[i].cost=String(p.costPrice)};
document.addEventListener('input',e=>{
  const t=e.target,k=t.dataset&&t.dataset.ph3,i=Number(t.dataset&&t.dataset.i);
  if(k==='po_name'){PO.rows[i].name=t.value;poSearchFill(i,t.value);if(PO.map[t.value]&&PO.rows[i].cost){const inp=document.querySelector('[data-ph3="po_cost"][data-i="'+i+'"]');if(inp&&!inp.value)inp.value=PO.rows[i].cost}poTotals()}
  else if(k==='po_qty'){PO.rows[i].qty=t.value;poTotals()}
  else if(k==='po_cost'){PO.rows[i].cost=t.value;poTotals()}
  else if(k==='po_paid'){PO.paid=t.value;poTotals()}
  else if(k==='po_exp')PO.rows[i].expiry=t.value;
  else if(k==='po_lot')PO.rows[i].lot=t.value;
  else if(k==='if_desc')IV.form.items[i].description=t.value;
  else if(k==='if_qty'){IV.form.items[i].qty=t.value;ifTotals()}
  else if(k==='if_price'){IV.form.items[i].price=t.value;ifTotals()}
  else if(k==='if_disc'){IV.form.discount=t.value;ifTotals()}
  else if(t.id==='su_search')suSearch(t.value);
  else if(t.id==='iv_search')ivSearch(t.value);
});
const suSearch=debounce(v=>{SU.search=v.trim();loadSuppliers()},250),ivSearch=debounce(v=>{IV.search=v.trim();loadInvoices()},250);
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.id==='ex_month'&&t.value){EX.month=t.value;renderExpenses()}
  else if(t.id==='ex_cat'){EX.cat=t.value;loadExpenses()}
  else if(t.id==='ex_branch'){EX.branch=t.value;loadExpenses()}
  else if(t.id==='fn_branch'){FN.branch=t.value;loadFinance()}
  else if(t.id==='fn_from'||t.id==='fn_to'){FN.from=$('#fn_from').value;FN.to=$('#fn_to').value;if(FN.from&&FN.to)loadFinance()}
});

/* ================= register tabs ================= */
BM.addTab('invoices','Invoices',ICON.invoices,'invoices.view',renderInvoices,'customers');
BM.addTab('expenses','Expenses',ICON.expenses,'expenses.view',renderExpenses,'invoices');
BM.addTab('suppliers','Suppliers',ICON.suppliers,'suppliers.view',renderSuppliers,'expenses');
BM.addTab('finance','Finance',ICON.finance,'finance.view',renderFinance,'suppliers');
BM.refresh();
})();
