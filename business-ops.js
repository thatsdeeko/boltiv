/* BOLTIV Business Manager, Phase 4 screens: Appointments, Staff (attendance and payroll), Stock tools
   (transfers, expiry, reorder) and Reports. Plugs into business.js through window.BM. */
(function(){
'use strict';
if(!window.BM)return;
const {S,api,toast,sheet,closeSheet,esc,money,m2,dt,num,uidk,can,busy,debounce,activeBranches,branchSel,banner,actions,todayStr,feat}=BM;
const $=s=>document.querySelector(s);
const needBiz=()=>'business_id='+S.bizId;
const guard=async fn=>{try{await fn()}catch(e){if(e&&e.message!=='auth')toast(e.message)}};
const addD=(d,n)=>{const t=new Date(d+'T00:00:00');t.setDate(t.getDate()+n);return t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0')};
const monthOf=d=>d.slice(0,7);
const METHODS=[['cash','Cash'],['transfer','Transfer'],['pos','POS'],['other','Other']];
const methodSel=(id,v)=>'<select class="f" id="'+id+'">'+METHODS.map(m=>'<option value="'+m[0]+'"'+(m[0]===(v||'cash')?' selected':'')+'>'+m[1]+'</option>').join('')+'</select>';
const safeCell=v=>typeof v==='string'&&/^[=+\-@\t\r]/.test(v)?"'"+v:v;
function download(name,rows){
  const csv=rows.map(r=>r.map(c=>{const s=String(safeCell(c)??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}).join(',')).join('\r\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv'}));a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),3000);
}
const upsell=(what,plan)=>'<div class="card"><h2>'+esc(what)+'</h2><div class="mut" style="margin:6px 0 12px">This is not included in your current plan. '+(plan||'Upgrade')+' to use it. Your existing data is never deleted.</div>'+(can('billing.view')?'<button class="btn" data-tab="billing">See plans</button>':'<div class="mut">Ask the business owner to upgrade.</div>')+'</div>';
const ICON={
  appointments:'<rect x="3.5" y="5" width="17" height="15.5" rx="2.6"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  staff:'<circle cx="12" cy="8" r="3.4"/><path d="M5 20c0-3.4 3-5.6 7-5.6s7 2.2 7 5.6"/><path d="M17.5 4.5l1.3 1.3 2.2-2.4"/>',
  stocktools:'<path d="M3 8l9-5 9 5-9 5z"/><path d="M3 12l9 5 9-5M3 16l9 5 9-5"/>',
  reports:'<path d="M4 20V9M10 20V4M16 20v-8M22 20H2"/><path d="M3 5l6 4 5-3 6 4"/>'
};
const pillFor=s=>({booked:['','Booked'],confirmed:['gold','Confirmed'],completed:['ok','Done'],cancelled:['bad','Cancelled'],no_show:['bad','No-show'],in_transit:['warn','In transit'],received:['ok','Received']}[s]||['',s]);

/* ================= Appointments ================= */
let AP={date:todayStr(),staff:'',branch:'',list:[],meta:{},idem:null,custMap:{}};
function renderAppointments(){
  if(!feat('appointments')){$('#view').innerHTML=upsell('Appointments','Move to the Growth plan');return}
  $('#view').innerHTML=banner(S.detail.subscription)+'<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Appointments</h2><div class="mut" id="apSub"></div></div>'+(can('appointments.manage')?'<button class="btn sm" data-act="apForm">Book</button>':'')+'</div>'+
    '<div class="row" style="border:0;padding:0 0 10px;gap:6px"><button class="btn ghost sm" data-act="apDay" data-d="-1" aria-label="Previous day">‹</button><input type="date" id="ap_date" value="'+AP.date+'" style="margin:0;flex:1"><button class="btn ghost sm" data-act="apDay" data-d="1" aria-label="Next day">›</button><button class="btn ghost sm" data-act="apDay" data-d="0">Today</button></div>'+
    branchSel('ap_branch',AP.branch,true)+'<select class="f" id="ap_staff" style="margin-bottom:6px"><option value="">All staff</option></select><div id="apList" style="margin-top:6px"><div class="empty"><span class="spin"></span></div></div></div>'+(AP.meta.canManageServices?'<button class="btn ghost block" data-act="svList">Manage services</button>':'');
  loadAppointments();
}
function loadAppointments(){guard(async()=>{
  const d=await api('/api/business/appointments?'+needBiz()+'&from='+AP.date+'&to='+AP.date+(AP.staff?'&staff_id='+AP.staff:'')+(AP.branch?'&branch_id='+AP.branch:''));AP.list=d.appointments;AP.meta=d;
  const sel=$('#ap_staff');if(sel)sel.innerHTML='<option value="">All staff</option>'+d.staff.map(s=>'<option value="'+s.id+'"'+(String(s.id)===String(AP.staff)?' selected':'')+'>'+esc(s.name)+'</option>').join('');
  const live=d.appointments.filter(a=>!['cancelled','no_show'].includes(a.status));
  const sub=$('#apSub');if(sub)sub.textContent=dt(AP.date)+' · '+live.length+' booking'+(live.length===1?'':'s')+(live.length?' · '+money(live.reduce((a,x)=>a+x.price,0))+' expected':'');
  $('#apList').innerHTML=d.appointments.length?d.appointments.map(a=>{const p=pillFor(a.status);return '<div class="row" data-act="apSheet" data-id="'+a.id+'" style="cursor:pointer"><div style="min-width:74px"><b>'+esc(a.start)+'</b><div class="mut">'+esc(a.end)+'</div></div><div class="grow"><div class="nm">'+esc(a.customerName)+'</div><div class="mut">'+esc(a.serviceName)+(a.staff?' · '+esc(a.staff):'')+'</div></div><div style="text-align:right"><span class="pill '+p[0]+'">'+p[1]+'</span><div class="mut">'+money(a.price)+'</div></div></div>'}).join(''):'<div class="empty">No appointments on this day.</div>';
})}
actions.apDay=el=>{const d=Number(el.dataset.d);AP.date=d===0?todayStr():addD(AP.date,d);renderAppointments()};
actions.apSheet=el=>{
  const a=AP.list.find(x=>x.id===Number(el.dataset.id));if(!a)return;const mg=can('appointments.manage'),open=['booked','confirmed'].includes(a.status),p=pillFor(a.status);
  const wa='https://wa.me/'+(a.customerPhone||'')+'?text='+encodeURIComponent('Hello '+a.customerName+', a reminder of your '+a.serviceName+' appointment at '+S.detail.business.name+' on '+dt(a.date)+' at '+a.start+'. Please reply to confirm. Thank you!');
  sheet('<h2>'+esc(a.customerName)+'</h2><div class="mut">'+esc(a.serviceName)+'</div><div class="grid g2" style="margin-top:12px"><div class="stat"><span class="mut">When</span><b>'+esc(a.start)+' – '+esc(a.end)+'</b><div class="mut">'+dt(a.date)+'</div></div><div class="stat"><span class="mut">Price</span><b>'+money(a.price)+'</b><div><span class="pill '+p[0]+'">'+p[1]+'</span></div></div></div>'+
    '<div class="mut" style="margin-top:10px">'+[a.staff?'With '+esc(a.staff):'',esc(a.branch),a.customerPhone?esc(a.customerPhone):''].filter(Boolean).join(' · ')+'</div>'+(a.notes?'<p>'+esc(a.notes)+'</p>':'')+(a.cancelReason?'<div class="banner bad" style="margin-top:10px">'+esc(a.cancelReason)+'</div>':'')+'<br>'+
    (mg&&open?(a.status==='booked'?'<button class="btn block" data-act="apStatus" data-id="'+a.id+'" data-s="confirmed">Confirm</button><br>':'')+(can('sales.create')?'<button class="btn block" data-act="apCharge" data-id="'+a.id+'">Charge and complete</button><br>':'')+'<button class="btn ghost block" data-act="apStatus" data-id="'+a.id+'" data-s="completed">Mark completed (no charge now)</button><br><div class="grid g2"><button class="btn ghost" data-act="apStatus" data-id="'+a.id+'" data-s="no_show">No-show</button><button class="btn bad" data-act="apStatus" data-id="'+a.id+'" data-s="cancelled">Cancel</button></div><br><button class="btn ghost block" data-act="apForm" data-id="'+a.id+'">Change time or details</button><br>':'')+
    (a.customerPhone&&open?'<a class="btn ghost block" style="text-align:center;text-decoration:none;display:block" target="_blank" rel="noopener" href="'+wa+'">WhatsApp reminder</a><br>':'')+'<button class="btn ghost block" data-act="close">Close</button>');
};
actions.apStatus=el=>{
  const st=el.dataset.s;let reason='';
  if(['cancelled','no_show'].includes(st)){reason=prompt(st==='cancelled'?'Reason for cancelling (optional):':'Note (optional):');if(reason===null)return}
  guard(async()=>{const d=await api('/api/business/appointments/status',{body:{businessId:S.bizId,appointmentId:Number(el.dataset.id),status:st,reason:(reason||'').trim()}});toast(d.message);closeSheet();loadAppointments()});
};
actions.apCharge=el=>{
  const a=AP.list.find(x=>x.id===Number(el.dataset.id));if(!a)return;closeSheet();
  BM.startSale({items:[{name:a.serviceName+' (appointment)',price:a.price,qty:1}],customer:a.customerId?{id:a.customerId,name:a.customerName,phone:a.customerPhone,balance:0}:null,apptId:a.id});
};
actions.apForm=el=>guard(async()=>{
  const id=el&&el.dataset&&el.dataset.id?Number(el.dataset.id):null,a=id?AP.list.find(x=>x.id===id):null;
  const cu=await api('/api/business/customers?'+needBiz()+'&limit=200');AP.custMap={};cu.customers.forEach(c=>{AP.custMap[c.name+(c.phone?' · '+c.phone:'')]=c});
  if(!id)AP.idem=uidk();AP.editing=a;
  const bs=activeBranches(),m=AP.meta,svc=m.services||[],stf=m.staff||[];
  sheet('<h2>'+(a?'Change appointment':'Book appointment')+'</h2><label>CUSTOMER</label><datalist id="ap_custs">'+Object.keys(AP.custMap).map(k=>'<option value="'+esc(k)+'">').join('')+'</datalist><input id="af_name" list="ap_custs" maxlength="80" value="'+esc(a?a.customerName:'')+'" placeholder="Name (or choose a saved customer)" autocomplete="off"><label>PHONE</label><input id="af_phone" inputmode="tel" maxlength="20" value="'+esc(a&&a.customerPhone||'')+'">'+
    '<label>SERVICE</label><select class="f" id="af_svc"><option value="">Other (type below)</option>'+svc.map(s=>'<option value="'+s.id+'"'+(a&&a.serviceId===s.id?' selected':'')+'>'+esc(s.name)+' · '+s.durationMin+' min · '+money(s.price)+'</option>').join('')+'</select><input id="af_sname" maxlength="80" value="'+esc(a?a.serviceName:'')+'" placeholder="Service name" style="margin-top:8px">'+
    '<div class="grid g2"><div><label>DATE</label><input type="date" id="af_date" value="'+(a?a.date:AP.date)+'" min="'+todayStr()+'"></div><div><label>TIME</label><input type="time" id="af_time" value="'+(a?a.start:'10:00')+'"></div></div>'+
    '<div class="grid g2"><div><label>DURATION (MIN)</label><input id="af_dur" inputmode="numeric" value="'+(a?a.durationMin:60)+'"></div><div><label>PRICE (₦)</label><input id="af_price" inputmode="decimal" value="'+(a?a.price:'')+'"></div></div>'+
    (stf.length?'<label>WITH (OPTIONAL)</label><select class="f" id="af_staff"><option value="">Anyone</option>'+stf.map(s=>'<option value="'+s.id+'"'+(a&&a.staffId===s.id?' selected':'')+'>'+esc(s.name)+'</option>').join('')+'</select>':'')+
    (bs.length>1?'<label>BRANCH</label><select class="f" id="af_branch">'+bs.map(b=>'<option value="'+b.id+'"'+((a?a.branchId:Number(AP.branch)||bs[0].id)===b.id?' selected':'')+'>'+esc(b.name)+'</option>').join('')+'</select>':'')+
    '<label>NOTES (OPTIONAL)</label><input id="af_notes" maxlength="300" value="'+esc(a&&a.notes||'')+'"><br><button class="btn block" data-act="apSave" data-id="'+(id||'')+'">'+(a?'Save changes':'Book appointment')+'</button><br><button class="btn ghost block" data-act="close">Cancel</button>');
});
actions.apSave=async el=>{
  const g=x=>$('#'+x).value.trim(),id=el.dataset.id?Number(el.dataset.id):null,c=AP.custMap[g('af_name')];
  const bs=activeBranches();busy(el,true,'Saving…');
  try{const d=await api('/api/business/appointments/save',{body:{businessId:S.bizId,id:id||undefined,branchId:$('#af_branch')?Number($('#af_branch').value):bs[0].id,customerId:c?c.id:(id&&AP.editing?AP.editing.customerId||undefined:undefined),customerName:c?c.name:g('af_name'),customerPhone:g('af_phone')||(c&&c.phone)||'',
      serviceId:$('#af_svc').value?Number($('#af_svc').value):undefined,serviceName:g('af_sname'),staffId:$('#af_staff')&&$('#af_staff').value?Number($('#af_staff').value):undefined,date:g('af_date'),time:g('af_time'),durationMin:num(g('af_dur')),price:num(g('af_price')),notes:g('af_notes'),idempotencyKey:id?undefined:AP.idem}});
    toast(d.message);closeSheet();AP.date=d.appointment.date;renderAppointments()}
  catch(e){toast(e.message);busy(el,false)}
};
document.addEventListener('change',e=>{
  if(e.target.id==='af_svc'){const s=(AP.meta.services||[]).find(x=>String(x.id)===e.target.value);if(s){$('#af_sname').value=s.name;$('#af_dur').value=s.durationMin;$('#af_price').value=s.price}}
});
actions.svList=()=>guard(async()=>{
  const d=await api('/api/business/services?'+needBiz());AP.services=d.services;
  sheet('<h2>Services</h2>'+(d.services.length?d.services.map(s=>'<div class="row" data-act="svForm" data-id="'+s.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(s.name)+(s.status!=='active'?' <span class="pill bad">Hidden</span>':'')+'</div><div class="mut">'+s.durationMin+' min</div></div><b>'+money(s.price)+'</b></div>').join(''):'<div class="empty">No services yet.</div>')+'<br><button class="btn block" data-act="svForm">Add service</button><br><button class="btn ghost block" data-act="close">Close</button>');
});
actions.svForm=el=>{
  const id=el&&el.dataset&&el.dataset.id?Number(el.dataset.id):null,s=id&&AP.services?AP.services.find(x=>x.id===id):null;
  sheet('<h2>'+(s?'Edit service':'Add service')+'</h2><label>NAME</label><input id="sv_name" maxlength="80" value="'+esc(s?s.name:'')+'"><div class="grid g2"><div><label>DURATION (MIN)</label><input id="sv_dur" inputmode="numeric" value="'+(s?s.durationMin:30)+'"></div><div><label>PRICE (₦)</label><input id="sv_price" inputmode="decimal" value="'+(s?s.price:'')+'"></div></div>'+(s?'<label>STATUS</label><select class="f" id="sv_status"><option value="active"'+(s.status==='active'?' selected':'')+'>Available</option><option value="inactive"'+(s.status!=='active'?' selected':'')+'>Hidden</option></select>':'')+'<br><button class="btn block" data-act="svSave" data-id="'+(id||'')+'">Save service</button><br><button class="btn ghost block" data-act="svList">Back</button>');
};
actions.svSave=async el=>{
  busy(el,true,'Saving…');
  try{const d=await api('/api/business/services/save',{body:{businessId:S.bizId,id:el.dataset.id?Number(el.dataset.id):undefined,name:$('#sv_name').value,durationMin:num($('#sv_dur').value),price:num($('#sv_price').value),status:$('#sv_status')?$('#sv_status').value:'active'}});toast(d.message);loadAppointments();actions.svList()}
  catch(e){toast(e.message);busy(el,false)}
};

/* ================= Staff ================= */
let SF={seg:'staff',search:'',list:[],meta:{},att:{date:todayStr(),entries:[]},month:monthOf(todayStr()),payIdem:null,payFor:null};
const segBar=(cur,items)=>'<div class="chips" style="margin:0 0 12px">'+items.map(i=>'<button class="chip'+(cur===i[0]?' on':'')+'" data-act="sfSeg" data-v="'+i[0]+'">'+i[1]+'</button>').join('')+'</div>';
function renderStaff(){
  const segs=[['staff','Staff'],['attendance','Attendance']].concat(can('payroll.manage')?[['payroll','Payroll']]:[]);
  const head=banner(S.detail.subscription);
  if(SF.seg==='attendance')return renderAttendance(head,segs);
  if(SF.seg==='payroll'&&can('payroll.manage'))return renderPayroll(head,segs);
  $('#view').innerHTML=head+'<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Staff</h2><div class="mut" id="sfSub"></div></div>'+(can('staff.manage')?'<button class="btn sm" data-act="sfForm">Add staff</button>':'')+'</div>'+segBar(SF.seg,segs)+'<input id="sf_search" placeholder="Search name or job title" value="'+esc(SF.search)+'"><div id="sfList" style="margin-top:10px"><div class="empty"><span class="spin"></span></div></div></div>';
  loadStaff();
}
function loadStaff(){guard(async()=>{
  const d=await api('/api/business/staff?'+needBiz()+'&status=all&search='+encodeURIComponent(SF.search));SF.list=d.staff;SF.meta=d;
  const sub=$('#sfSub');if(sub)sub.textContent=d.staff.filter(s=>s.status==='active').length+' active';
  $('#sfList').innerHTML=d.staff.length?d.staff.map(s=>'<div class="row" data-act="sfSheet" data-id="'+s.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(s.name)+'</div><div class="mut">'+esc([s.jobTitle,s.branch].filter(Boolean).join(' · ')||'—')+'</div></div>'+(s.status!=='active'?'<span class="pill bad">Inactive</span>':'')+(d.canPay&&s.payAmount?'<span class="mut">'+money(s.payAmount)+'/'+(s.payType==='monthly'?'mo':s.payType==='weekly'?'wk':'day')+'</span>':'')+'</div>').join(''):'<div class="empty">No staff yet.</div>';
})}
actions.sfSeg=el=>{SF.seg=el.dataset.v;renderStaff()};
actions.sfForm=el=>{
  const id=el&&el.dataset&&el.dataset.id?Number(el.dataset.id):null,s=id?SF.list.find(x=>x.id===id):null,bs=activeBranches(),pay=SF.meta.canPay;
  sheet('<h2>'+(s?'Edit staff':'Add staff')+'</h2><label>FULL NAME</label><input id="st_name" maxlength="80" value="'+esc(s?s.name:'')+'"><div class="grid g2"><div><label>PHONE</label><input id="st_phone" inputmode="tel" maxlength="20" value="'+esc(s&&s.phone||'')+'"></div><div><label>JOB TITLE</label><input id="st_title" maxlength="60" value="'+esc(s&&s.jobTitle||'')+'"></div></div><label>EMAIL (OPTIONAL)</label><input id="st_email" maxlength="120" value="'+esc(s&&s.email||'')+'">'+
    (bs.length>1?'<label>BRANCH</label><select class="f" id="st_branch"><option value="">All branches</option>'+bs.map(b=>'<option value="'+b.id+'"'+(s&&s.branchId===b.id?' selected':'')+'>'+esc(b.name)+'</option>').join('')+'</select>':'')+
    (pay?'<div class="grid g2"><div><label>PAID</label><select class="f" id="st_ptype">'+['monthly','weekly','daily'].map(t=>'<option value="'+t+'"'+((s?s.payType:'monthly')===t?' selected':'')+'>'+t[0].toUpperCase()+t.slice(1)+'</option>').join('')+'</select></div><div><label>PAY (₦)</label><input id="st_pay" inputmode="decimal" value="'+(s&&s.payAmount||'')+'"></div></div>':'')+
    '<label>START DATE (OPTIONAL)</label><input type="date" id="st_start" value="'+esc(s&&s.startDate||'')+'">'+(s?'<label>STATUS</label><select class="f" id="st_status"><option value="active"'+(s.status==='active'?' selected':'')+'>Active</option><option value="inactive"'+(s.status!=='active'?' selected':'')+'>Inactive</option></select>':'')+
    '<label>NOTES (OPTIONAL)</label><input id="st_notes" maxlength="300" value="'+esc(s&&s.notes||'')+'"><br><button class="btn block" data-act="sfSave" data-id="'+(id||'')+'">Save</button><br><button class="btn ghost block" data-act="close">Cancel</button>');
};
actions.sfSave=async el=>{
  const g=x=>$('#'+x)?$('#'+x).value.trim():undefined,id=el.dataset.id?Number(el.dataset.id):null;busy(el,true,'Saving…');
  const body={businessId:S.bizId,id:id||undefined,name:g('st_name'),phone:g('st_phone'),jobTitle:g('st_title'),email:g('st_email'),startDate:g('st_start'),notes:g('st_notes')};
  if($('#st_branch'))body.branchId=$('#st_branch').value;else if(!id)body.branchId=activeBranches().length===1?String(activeBranches()[0].id):'';
  if($('#st_ptype')){body.payType=g('st_ptype');body.payAmount=num(g('st_pay'))}
  if($('#st_status'))body.status=g('st_status');
  try{const d=await api('/api/business/staff/save',{body});toast(d.message);closeSheet();loadStaff()}catch(e){toast(e.message);busy(el,false)}
};
actions.sfSheet=el=>guard(async()=>{
  const d=await api('/api/business/staff/detail?'+needBiz()+'&id='+el.dataset.id+'&month='+SF.month),s=d.staff,att=d.attendance;SF.cur=d;
  sheet('<h2>'+esc(s.name)+'</h2><div class="mut">'+esc([s.jobTitle,s.phone,s.email].filter(Boolean).join(' · ')||'No details')+'</div>'+(s.status!=='active'?'<div class="banner bad" style="margin-top:10px">Inactive</div>':'')+
    '<h2 style="margin-top:16px">Attendance · '+esc(new Date(d.month+'-01T00:00:00').toLocaleDateString('en-NG',{month:'long',year:'numeric'}))+'</h2><div class="grid g2" style="margin-top:8px"><div class="stat"><span class="mut">Present</span><b>'+(att.present||0)+'</b></div><div class="stat"><span class="mut">Late</span><b>'+(att.late||0)+'</b></div><div class="stat"><span class="mut">Absent</span><b>'+(att.absent||0)+'</b></div><div class="stat"><span class="mut">Leave</span><b>'+(att.leave||0)+'</b></div></div>'+
    (SF.meta.canPay?'<h2 style="margin-top:16px">Pay</h2><div class="mut">'+money(s.payAmount)+' '+esc(s.payType)+'</div>'+(d.payments.length?d.payments.map(p=>'<div class="row"><div class="grow"><div class="nm">'+esc(p.period)+(p.status==='void'?' <span class="pill bad">VOID</span>':'')+'</div><div class="mut">'+dt(p.paidOn)+' · '+esc(p.method)+'</div></div><b>'+money(p.net)+'</b>'+(p.status==='active'?'<button class="btn ghost sm" data-act="prVoid" data-id="'+p.id+'">Void</button>':'')+'</div>').join(''):'<div class="mut">No salary payments yet.</div>')+'<br><button class="btn block" data-act="prForm" data-id="'+s.id+'">Pay salary</button>':'')+
    '<br>'+(SF.meta.canManage?'<button class="btn ghost block" data-act="sfForm" data-id="'+s.id+'">Edit details</button><br>':'')+'<button class="btn ghost block" data-act="close">Close</button>');
});
/* attendance */
function renderAttendance(head,segs){
  $('#view').innerHTML=head+'<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Attendance</h2></div><input type="date" id="at_date" value="'+SF.att.date+'" max="'+todayStr()+'" style="width:auto;margin:0"></div>'+segBar('attendance',segs)+'<div id="atList"><div class="empty"><span class="spin"></span></div></div></div>';
  guard(async()=>{
    const d=await api('/api/business/staff/attendance?'+needBiz()+'&date='+SF.att.date);SF.att.entries=d.entries.map(e=>({...e}));SF.att.canManage=d.canManage;drawAttendance();
  });
}
const ATT=[['present','Present'],['late','Late'],['absent','Absent'],['leave','Leave']];
function drawAttendance(){
  const box=$('#atList');if(!box)return;const es=SF.att.entries,mg=SF.att.canManage;
  box.innerHTML=es.length?(mg?'<button class="btn ghost sm" data-act="atAll" style="margin-bottom:8px">Mark everyone present</button>':'')+es.map((e,i)=>'<div class="row" style="flex-wrap:wrap"><div class="grow"><div class="nm">'+esc(e.name)+'</div><div class="mut">'+esc([e.jobTitle,e.branch].filter(Boolean).join(' · '))+'</div></div><div class="chips" style="margin:0">'+ATT.map(a=>'<button class="chip'+(e.status===a[0]?' on':'')+'"'+(mg?'':' disabled')+' data-act="atSet" data-i="'+i+'" data-v="'+a[0]+'">'+a[1]+'</button>').join('')+'</div></div>').join('')+(mg?'<br><button class="btn block" data-act="atSave">Save attendance</button>':''):'<div class="empty">Add staff first.</div>';
}
actions.atSet=el=>{const e=SF.att.entries[Number(el.dataset.i)];if(e){e.status=el.dataset.v;drawAttendance()}};
actions.atAll=()=>{SF.att.entries.forEach(e=>{if(!e.status)e.status='present'});drawAttendance()};
actions.atSave=async el=>{
  const entries=SF.att.entries.filter(e=>e.status).map(e=>({staffId:e.staffId,status:e.status,note:e.note||''}));if(!entries.length){toast('Mark at least one person');return}
  busy(el,true,'Saving…');
  try{const d=await api('/api/business/staff/attendance',{body:{businessId:S.bizId,date:SF.att.date,entries}});toast(d.message);busy(el,false)}catch(e){toast(e.message);busy(el,false)}
};
/* payroll */
function renderPayroll(head,segs){
  $('#view').innerHTML=head+'<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Payroll</h2><div class="mut" id="prSub"></div></div><input type="month" id="pr_month" value="'+SF.month+'" style="width:auto;margin:0"></div>'+segBar('payroll',segs)+'<div id="prBody"><div class="empty"><span class="spin"></span></div></div></div>';
  guard(async()=>{
    const d=await api('/api/business/payroll?'+needBiz()+'&month='+SF.month);const sub=$('#prSub');if(sub)sub.textContent='Paid this month: '+money(d.total);
    $('#prBody').innerHTML=(d.unpaid.length?'<h2>Not yet paid</h2>'+d.unpaid.map(u=>'<div class="row"><div class="grow"><div class="nm">'+esc(u.name)+'</div><div class="mut">'+money(u.payAmount)+' '+esc(u.payType)+'</div></div><button class="btn sm" data-act="prForm" data-id="'+u.id+'">Pay</button></div>').join(''):'<div class="mut">Everyone active has been paid for this month.</div>')+
      (d.payments.length?'<h2 style="margin-top:16px">Payments</h2>'+d.payments.map(p=>'<div class="row"><div class="grow"><div class="nm">'+esc(p.staff)+(p.status==='void'?' <span class="pill bad">VOID</span>':'')+'</div><div class="mut">'+dt(p.paidOn)+' · '+esc(p.method)+(p.bonus?' · bonus '+money(p.bonus):'')+(p.deductions?' · less '+money(p.deductions):'')+'</div></div><b>'+money(p.net)+'</b>'+(p.status==='active'?'<button class="btn ghost sm" data-act="prVoid" data-id="'+p.id+'">Void</button>':'')+'</div>').join(''):'');
  });
}
actions.prForm=el=>{
  const id=Number(el.dataset.id),s=(SF.list.find(x=>x.id===id))||(SF.cur&&SF.cur.staff.id===id?SF.cur.staff:null);if(!s){toast('Open Staff first');return}
  SF.payFor=s;SF.payIdem=uidk();SF.force=false;
  sheet('<h2>Pay '+esc(s.name)+'</h2><div class="grid g2"><div><label>FOR MONTH</label><input type="month" id="pf2_period" value="'+SF.month+'"></div><div><label>DATE PAID</label><input type="date" id="pf2_date" value="'+todayStr()+'" max="'+todayStr()+'"></div></div><label>BASE PAY (₦)</label><input data-ph4="pay" id="pf2_amt" inputmode="decimal" value="'+(s.payAmount||'')+'"><div class="grid g2"><div><label>BONUS (₦)</label><input data-ph4="pay" id="pf2_bonus" inputmode="decimal" placeholder="0"></div><div><label>DEDUCTIONS (₦)</label><input data-ph4="pay" id="pf2_ded" inputmode="decimal" placeholder="0"></div></div><div class="sum" id="pf2_net"></div><label>PAID BY</label>'+methodSel('pf2_method')+'<label>NOTE (OPTIONAL)</label><input id="pf2_note" maxlength="200"><br><button class="btn block" data-act="prPay">Record payment</button><br><button class="btn ghost block" data-act="close">Cancel</button>');
  prNet();
};
function prNet(){const n=Math.round(num($('#pf2_amt').value)*100)+Math.round(num($('#pf2_bonus').value)*100)-Math.round(num($('#pf2_ded').value)*100);const b=$('#pf2_net');if(b)b.innerHTML='<div class="tot"><span>Net pay</span><span style="'+(n<=0?'color:var(--bad)':'')+'">'+m2(n/100)+'</span></div><div class="mut" style="font-size:12px">This is also recorded as a salary expense.</div>'}
actions.prPay=async el=>{
  const body={businessId:S.bizId,staffId:SF.payFor.id,period:$('#pf2_period').value,date:$('#pf2_date').value,amount:num($('#pf2_amt').value),bonus:num($('#pf2_bonus').value),deductions:num($('#pf2_ded').value),method:$('#pf2_method').value,note:$('#pf2_note').value,idempotencyKey:SF.payIdem,force:SF.force||undefined};
  busy(el,true,'Saving…');
  try{const d=await api('/api/business/payroll/pay',{body});toast(d.message);closeSheet();if(S.tab==='staff')renderStaff()}
  catch(e){busy(el,false);if(e.data&&e.data.code==='duplicate_period'){if(confirm(e.message+'\n\nRecord an extra payment anyway?')){SF.force=true;actions.prPay(el)}}else toast(e.message)}
};
actions.prVoid=el=>{
  const reason=prompt('Why are you voiding this salary payment? (required)');if(!reason||reason.trim().length<3||!confirm('Void this payment? The salary expense is voided too.'))return;
  guard(async()=>{const d=await api('/api/business/payroll/void',{body:{businessId:S.bizId,paymentId:Number(el.dataset.id),reason:reason.trim()}});toast(d.message);closeSheet();if(S.tab==='staff')renderStaff()});
};
document.addEventListener('input',e=>{
  if(e.target.dataset&&e.target.dataset.ph4==='pay')prNet();
  else if(e.target.id==='sf_search')sfSearch(e.target.value);
});
const sfSearch=debounce(v=>{SF.search=v.trim();loadStaff()},250);
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.id==='at_date'&&t.value){SF.att.date=t.value;renderStaff()}
  else if(t.id==='pr_month'&&t.value){SF.month=t.value;renderStaff()}
  else if(t.id==='ap_date'&&t.value){AP.date=t.value;renderAppointments()}
  else if(t.id==='ap_staff'){AP.staff=t.value;loadAppointments()}
  else if(t.id==='ap_branch'){AP.branch=t.value;AP.staff='';loadAppointments()}
});

/* ================= Stock tools (Growth and above): transfers, expiry, reorder ================= */
let T4={seg:'transfers',days:60,list:[],lots:[],reorder:null,tfRows:[],tfProds:{},idem:null};
function renderStockTools(){
  if(!feat('advanced_inventory')){$('#view').innerHTML=upsell('Branch transfers and expiry tracking','Move to the Growth plan');return}
  const segs=[['transfers','Transfers'],['expiry','Expiry'],['reorder','Reorder']];
  const head=banner(S.detail.subscription)+'<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Stock tools</h2></div>';
  const bar=segBarX(T4.seg,segs);
  if(T4.seg==='expiry'){
    $('#view').innerHTML=head+(can('inventory.manage')?'<button class="btn sm" data-act="lotForm">Add expiry</button>':'')+'</div>'+bar+'<div class="chips" style="margin-bottom:10px">'+[30,60,90,180].map(d=>'<button class="chip'+(T4.days===d?' on':'')+'" data-act="exDays" data-v="'+d+'">'+d+' days</button>').join('')+'</div><div id="t4Body"><div class="empty"><span class="spin"></span></div></div><div class="mut" style="margin-top:10px;font-size:12px">Remaining quantities are estimated: the stock that expires first is assumed to be sold first.</div></div>';
    guard(async()=>{
      const d=await api('/api/business/lots/expiry?'+needBiz()+'&days='+T4.days);T4.lots=d.lots;
      const grp={expired:[],soon:[],ok:[]};d.lots.forEach(l=>grp[l.status].push(l));
      const rows=(arr,title,cls)=>arr.length?'<h2 class="'+cls+'" style="margin:12px 0 4px">'+title+' ('+arr.length+')</h2>'+arr.map(l=>'<div class="row"><div class="grow"><div class="nm">'+esc(l.product)+'</div><div class="mut">'+esc(l.branch)+(l.lotNo?' · lot '+esc(l.lotNo):'')+' · expires '+dt(l.expiry)+'</div></div><div style="text-align:right"><b>'+l.remaining+' '+esc(l.unit)+'</b>'+(l.value!==undefined?'<div class="mut">'+money(l.value)+'</div>':'')+'</div></div>').join(''):'';
      $('#t4Body').innerHTML=(rows(grp.expired,'Expired','neg-t')+rows(grp.soon,'Expiring within 30 days','')+rows(grp.ok,'Later','')).trim()||'<div class="empty">Nothing expires in the next '+T4.days+' days.<br><span class="mut">Record expiry dates when you buy or restock to track them here.</span></div>';
    });
  }else if(T4.seg==='reorder'){
    $('#view').innerHTML=head+'<button class="btn ghost sm" data-act="roExport">Export CSV</button></div>'+bar+'<div id="t4Body"><div class="empty"><span class="spin"></span></div></div></div>';
    guard(async()=>{
      const d=await api('/api/business/stock/reorder?'+needBiz());T4.reorder=d;
      $('#t4Body').innerHTML=d.items.length?d.items.map(i=>'<div class="row"><div class="grow"><div class="nm">'+esc(i.name)+'</div><div class="mut">'+i.stock+' left · alert at '+i.reorderLevel+'</div></div><div style="text-align:right"><b>Buy '+i.suggested+' '+esc(i.unit)+'</b>'+(i.estCost!==undefined?'<div class="mut">≈ '+money(i.estCost)+'</div>':'')+'</div></div>').join('')+(d.estTotal!==undefined?'<div class="sum"><div class="tot"><span>Estimated cost</span><span>'+m2(d.estTotal)+'</span></div></div>':''):'<div class="empty">Nothing needs reordering. Set a low-stock alert level on your products to get suggestions.</div>';
    });
  }else{
    $('#view').innerHTML=head+(can('inventory.manage')?'<button class="btn sm" data-act="tfForm">New transfer</button>':'')+'</div>'+bar+'<div id="t4Body"><div class="empty"><span class="spin"></span></div></div></div>';
    guard(async()=>{
      const d=await api('/api/business/transfers?'+needBiz());T4.list=d.transfers;
      $('#t4Body').innerHTML=d.transfers.length?d.transfers.map(t=>{const p=pillFor(t.status);return '<div class="row" data-act="tfSheet" data-id="'+t.id+'" style="cursor:pointer"><div class="grow"><div class="nm">'+esc(t.transferNo)+'</div><div class="mut">'+esc(t.from)+' → '+esc(t.to)+' · '+dt(t.createdAt)+'</div></div><span class="pill '+p[0]+'">'+p[1]+'</span></div>'}).join(''):'<div class="empty">No transfers yet. Move stock between your branches here.</div>';
    });
  }
}
function segBarX(cur,items){return '<div class="chips" style="margin:0 0 12px">'+items.map(i=>'<button class="chip'+(cur===i[0]?' on':'')+'" data-act="t4Seg" data-v="'+i[0]+'">'+i[1]+'</button>').join('')+'</div>'}
actions.t4Seg=el=>{T4.seg=el.dataset.v;renderStockTools()};
actions.exDays=el=>{T4.days=Number(el.dataset.v);renderStockTools()};
actions.roExport=()=>{const d=T4.reorder;if(!d)return;download('boltiv-reorder-'+todayStr()+'.csv',[['Product','In stock','Alert level','Suggested order','Estimated cost']].concat(d.items.map(i=>[i.name,i.stock,i.reorderLevel,i.suggested,i.estCost===undefined?'':i.estCost])))};
async function loadTfProducts(branchId){
  const d=await api('/api/business/products?'+needBiz()+'&branch_id='+branchId+'&limit=200');T4.tfProds={};d.products.filter(p=>p.trackStock&&p.stock>0).forEach(p=>{T4.tfProds[p.name+(p.sku?' · '+p.sku:'')]=p});
  const dl=$('#tf_prods');if(dl)dl.innerHTML=Object.keys(T4.tfProds).map(k=>'<option value="'+esc(k)+'">').join('');
}
actions.tfForm=()=>guard(async()=>{
  const bs=activeBranches();if(bs.length<2){toast('Add a second branch first (Branches tab)');return}
  T4.tfRows=[{name:'',qty:''}];T4.idem=uidk();
  sheet('<h2>Transfer stock</h2><div class="mut">Stock leaves the sending branch now and is added to the receiving branch when they confirm it arrived.</div><div class="grid g2"><div><label>FROM</label><select class="f" id="tf_from">'+bs.map(b=>'<option value="'+b.id+'">'+esc(b.name)+'</option>').join('')+'</select></div><div><label>TO</label><select class="f" id="tf_to">'+bs.map((b,i)=>'<option value="'+b.id+'"'+(i===1?' selected':'')+'>'+esc(b.name)+'</option>').join('')+'</select></div></div><label>ITEMS</label><datalist id="tf_prods"></datalist><div id="tfRows"></div><button class="btn ghost sm" data-act="tfAdd" style="margin-top:8px">+ Add item</button><label>NOTE (OPTIONAL)</label><input id="tf_note" maxlength="200"><br><button class="btn block" data-act="tfSave">Send transfer</button><br><button class="btn ghost block" data-act="close">Cancel</button>');
  drawTfRows();await loadTfProducts(bs[0].id);
});
function drawTfRows(){const b=$('#tfRows');if(!b)return;b.innerHTML=T4.tfRows.map((r,i)=>'<div class="row" style="gap:6px"><div class="grow"><input list="tf_prods" data-ph4="tf_name" data-i="'+i+'" value="'+esc(r.name)+'" placeholder="Choose product" style="margin-bottom:6px"><input data-ph4="tf_qty" data-i="'+i+'" value="'+esc(r.qty)+'" inputmode="decimal" placeholder="Quantity" style="margin:0"></div><button class="x" data-act="tfRm" data-i="'+i+'" aria-label="Remove">✕</button></div>').join('')}
actions.tfAdd=()=>{T4.tfRows.push({name:'',qty:''});drawTfRows()};
actions.tfRm=el=>{if(T4.tfRows.length>1){T4.tfRows.splice(Number(el.dataset.i),1);drawTfRows()}};
actions.tfSave=async el=>{
  const items=[];for(const r of T4.tfRows){const p=T4.tfProds[r.name];if(!p){toast('Choose each product from the list');return}items.push({productId:p.id,qty:num(r.qty)})}
  busy(el,true,'Sending…');
  try{const d=await api('/api/business/transfers/create',{body:{businessId:S.bizId,fromBranchId:Number($('#tf_from').value),toBranchId:Number($('#tf_to').value),items,note:$('#tf_note').value,idempotencyKey:T4.idem}});toast(d.message);closeSheet();renderStockTools()}
  catch(e){toast(e.message);busy(el,false)}
};
actions.tfSheet=el=>guard(async()=>{
  const d=await api('/api/business/transfers/detail?'+needBiz()+'&id='+el.dataset.id),t=d.transfer,p=pillFor(t.status);
  sheet('<h2>'+esc(t.transferNo)+' <span class="pill '+p[0]+'">'+p[1]+'</span></h2><div class="mut">'+esc(t.from)+' → '+esc(t.to)+' · '+dt(t.createdAt)+(t.by?' · '+esc(t.by):'')+'</div>'+(t.note?'<p>'+esc(t.note)+'</p>':'')+'<div style="margin-top:10px">'+t.items.map(i=>'<div class="row"><div class="grow nm">'+esc(i.name)+'</div><b>'+i.qty+' '+esc(i.unit||'')+'</b></div>').join('')+'</div>'+(t.cancelReason?'<div class="banner bad" style="margin-top:10px">'+esc(t.cancelReason)+'</div>':'')+'<br>'+
    (d.canReceive?'<button class="btn block" data-act="tfReceive" data-id="'+t.id+'">Confirm received at '+esc(t.to)+'</button><br>':'')+(d.canCancel?'<button class="btn bad block" data-act="tfCancel" data-id="'+t.id+'">Cancel and return to '+esc(t.from)+'</button><br>':'')+'<button class="btn ghost block" data-act="close">Close</button>');
});
actions.tfReceive=el=>{if(!confirm('Confirm that this stock has arrived?'))return;guard(async()=>{const d=await api('/api/business/transfers/receive',{body:{businessId:S.bizId,transferId:Number(el.dataset.id)}});toast(d.message);closeSheet();renderStockTools()})};
actions.tfCancel=el=>{const r=prompt('Why are you cancelling this transfer? (required)');if(!r||r.trim().length<3)return;guard(async()=>{const d=await api('/api/business/transfers/cancel',{body:{businessId:S.bizId,transferId:Number(el.dataset.id),reason:r.trim()}});toast(d.message);closeSheet();renderStockTools()})};
actions.lotForm=()=>guard(async()=>{
  const bs=activeBranches(),pr=await api('/api/business/products?'+needBiz()+'&limit=200');T4.lotProds={};pr.products.filter(p=>p.trackStock).forEach(p=>{T4.lotProds[p.name+(p.sku?' · '+p.sku:'')]=p});
  sheet('<h2>Record expiry</h2><div class="mut">For stock you already have. The quantity cannot be more than what is in stock.</div><label>PRODUCT</label><datalist id="lt_prods">'+Object.keys(T4.lotProds).map(k=>'<option value="'+esc(k)+'">').join('')+'</datalist><input id="lt_name" list="lt_prods" placeholder="Choose product" autocomplete="off">'+
    (bs.length>1?'<label>BRANCH</label><select class="f" id="lt_branch">'+bs.map(b=>'<option value="'+b.id+'">'+esc(b.name)+'</option>').join('')+'</select>':'')+'<div class="grid g2"><div><label>EXPIRY DATE</label><input type="date" id="lt_exp"></div><div><label>QUANTITY</label><input id="lt_qty" inputmode="decimal"></div></div><label>BATCH / LOT NO. (OPTIONAL)</label><input id="lt_lot" maxlength="40"><br><button class="btn block" data-act="lotSave">Save</button><br><button class="btn ghost block" data-act="close">Cancel</button>');
});
actions.lotSave=async el=>{
  const p=T4.lotProds[$('#lt_name').value.trim()];if(!p){toast('Choose the product from the list');return}busy(el,true,'Saving…');
  try{const d=await api('/api/business/lots/add',{body:{businessId:S.bizId,productId:p.id,branchId:$('#lt_branch')?Number($('#lt_branch').value):activeBranches()[0].id,lotNo:$('#lt_lot').value,expiry:$('#lt_exp').value,qty:num($('#lt_qty').value)}});toast(d.message);closeSheet();renderStockTools()}
  catch(e){toast(e.message);busy(el,false)}
};
document.addEventListener('input',e=>{
  const t=e.target,k=t.dataset&&t.dataset.ph4,i=Number(t.dataset&&t.dataset.i);
  if(k==='tf_name')T4.tfRows[i].name=t.value;else if(k==='tf_qty')T4.tfRows[i].qty=t.value;
});
document.addEventListener('change',async e=>{if(e.target.id==='tf_from')guard(()=>loadTfProducts(e.target.value))});

/* ================= Reports ================= */
let RP={preset:'30',from:'',to:'',branch:'',sales:null,inv:null};
function rpRange(){
  const t=todayStr();
  if(RP.preset==='7')return {from:addD(t,-6),to:t};
  if(RP.preset==='30')return {from:addD(t,-29),to:t};
  if(RP.preset==='month')return {from:t.slice(0,8)+'01',to:t};
  if(RP.preset==='last'){const d=new Date(t+'T00:00:00');d.setDate(1);d.setMonth(d.getMonth()-1);const y=d.getFullYear(),m=d.getMonth()+1;return {from:y+'-'+String(m).padStart(2,'0')+'-01',to:y+'-'+String(m).padStart(2,'0')+'-'+String(new Date(y,m,0).getDate()).padStart(2,'0')}}
  if(RP.preset==='year')return {from:t.slice(0,4)+'-01-01',to:t};
  return {from:RP.from||addD(t,-29),to:RP.to||t};
}
function renderReports(){
  const chips=[['7','7 days'],['30','30 days'],['month','This month'],['last','Last month'],['year','This year'],['custom','Custom']],r=rpRange();
  $('#view').innerHTML='<div class="card"><div class="row" style="border:0;padding-top:0"><div class="grow"><h2>Reports</h2><div class="mut" id="rpSub"></div></div><button class="btn ghost sm" data-act="rpExport">Export CSV</button></div><div class="chips" style="overflow-x:auto;white-space:nowrap">'+chips.map(c=>'<button class="chip'+(RP.preset===c[0]?' on':'')+'" data-act="rpPreset" data-v="'+c[0]+'">'+c[1]+'</button>').join('')+'</div>'+
    (RP.preset==='custom'?'<div class="grid g2" style="margin-top:10px"><input type="date" id="rp_from" value="'+r.from+'" max="'+todayStr()+'"><input type="date" id="rp_to" value="'+r.to+'" max="'+todayStr()+'"></div>':'')+'<div style="margin-top:10px">'+branchSel('rp_branch',RP.branch,true)+'</div></div><div id="rpBody"><div class="empty"><span class="spin"></span></div></div>';
  loadReports();
}
function colChart(points,key,labelOf){
  if(!points.length)return '<div class="empty">No sales in this period.</div>';
  const W=320,H=120,max=Math.max(1,...points.map(p=>p[key])),bw=Math.max(3,Math.min(22,(W-10)/points.length-3));
  return '<svg class="chart" viewBox="0 0 '+W+' '+(H+4)+'" preserveAspectRatio="none" role="img">'+points.map((p,i)=>{const x=6+i*((W-12)/points.length),h=Math.max(1,Math.round(p[key]/max*H));return '<rect x="'+x.toFixed(1)+'" y="'+(H-h)+'" width="'+bw+'" height="'+h+'" rx="2" fill="var(--gold)"><title>'+esc(labelOf(p))+': '+money(p[key])+'</title></rect>'}).join('')+'</svg>';
}
const listBars=(items,labelK,valK,extra)=>{const max=Math.max(1,...items.map(x=>x[valK]));return items.length?items.map(x=>'<div style="margin:8px 0"><div class="row" style="border:0;padding:0"><div class="grow" style="font-size:13px">'+esc(String(x[labelK]))+(extra?' <span class="mut">'+esc(extra(x))+'</span>':'')+'</div><b style="font-size:13px">'+m2(x[valK])+'</b></div><div class="bar1"><i style="width:'+Math.max(3,Math.round(x[valK]/max*100))+'%"></i></div></div>').join(''):'<div class="empty">No data.</div>'};
function loadReports(){guard(async()=>{
  const money=m2,r=rpRange(),box=$('#rpBody'),qs=needBiz()+'&from='+r.from+'&to='+r.to+(RP.branch?'&branch_id='+RP.branch:'');
  let s,inv;
  try{[s,inv]=await Promise.all([api('/api/business/reports/sales?'+qs),api('/api/business/reports/inventory?'+needBiz()+(RP.branch?'&branch_id='+RP.branch:''))])}
  catch(e){box.innerHTML=e.data&&e.data.code==='plan_feature'?upsell('Longer reports','Move to the Growth plan')+'<div class="mut" style="padding:0 6px">'+esc(e.message)+'</div>':'<div class="card empty">'+esc(e.message)+'</div>';return}
  RP.sales=s;RP.inv=inv;const full=s.level==='full',t=s.totals,sub=$('#rpSub');if(sub)sub.textContent=dt(s.range.from)+' – '+dt(s.range.to)+' · '+(full?'Full reports':'Basic reports');
  const lock=(what)=>'<div class="card"><h2>'+what+'</h2><div class="mut" style="margin:6px 0 12px">Included in the Growth plan.</div>'+(can('billing.view')?'<button class="btn ghost sm" data-tab="billing">See plans</button>':'')+'</div>';
  box.innerHTML='<div class="card"><div class="grid g2"><div class="stat"><span class="mut">Sales</span><b>'+t.count+'</b></div><div class="stat"><span class="mut">Total</span><b>'+money(t.total)+'</b></div><div class="stat"><span class="mut">Average sale</span><b>'+money(t.average)+'</b></div><div class="stat"><span class="mut">Discounts given</span><b>'+money(t.discount)+'</b></div>'+(t.credit>0?'<div class="stat"><span class="mut">Sold on credit</span><b>'+money(t.credit)+'</b></div>':'')+(t.voided?'<div class="stat"><span class="mut">Voided sales</span><b>'+t.voided+'</b></div>':'')+'</div></div>'+
    '<div class="card"><h2>Sales by day</h2>'+colChart(s.daily,'total',p=>p.day)+'</div>'+
    '<div class="card"><h2>Payment methods</h2>'+listBars(s.methods,'method','amount')+'</div>'+
    '<div class="card tbl"><h2>Top products</h2>'+(s.topProducts.length?s.topProducts.map(p=>'<div class="row"><div class="grow"><div class="nm">'+esc(p.name)+'</div><div class="mut">'+p.qty+' sold</div></div><div style="text-align:right"><b>'+money(p.revenue)+'</b><div class="mut '+(p.profit>=0?'pos-t':'neg-t')+'">profit '+money(p.profit)+'</div></div></div>').join(''):'<div class="empty">No sales in this period.</div>')+'</div>'+
    (full?'<div class="card"><h2>By category</h2>'+listBars(s.byCategory,'name','revenue',x=>x.qty+' sold')+'</div><div class="card"><h2>By cashier</h2>'+listBars(s.byCashier,'name','total',x=>x.count+' sales')+'</div>'+(s.byBranch.length>1?'<div class="card"><h2>By branch</h2>'+listBars(s.byBranch,'name','total',x=>x.count+' sales')+'</div>':'')+'<div class="card"><h2>Busiest hours</h2>'+colChart(s.byHour,'total',p=>p.hour+':00')+'<div class="mut" style="font-size:12px">Hour of day, 0 to 23 (Lagos time)</div></div><div class="card"><h2>Top customers</h2>'+listBars(s.topCustomers,'name','total',x=>x.count+' sales')+'</div>':lock('Category, cashier, branch, busiest hours and customer reports')+'')+
    '<div class="card tbl"><h2>Stock</h2>'+(inv.valuation.length?inv.valuation.map(v=>'<div class="row"><div class="grow"><div class="nm">'+esc(v.branch)+'</div><div class="mut">'+v.items+' items</div></div><div style="text-align:right"><b>'+money(v.retail)+'</b><div class="mut">cost '+money(v.cost)+'</div></div></div>').join(''):'<div class="empty">No stock on hand.</div>')+'<div class="row"><div class="grow">Items at or below their alert level</div><b>'+inv.lowStock+'</b></div></div>'+
    (full?'<div class="card tbl"><h2>Not selling</h2><div class="mut">In stock, but no sales in 60 days.</div>'+(inv.deadStock.length?inv.deadStock.map(x=>'<div class="row"><div class="grow"><div class="nm">'+esc(x.name)+'</div><div class="mut">'+x.qty+' '+esc(x.unit)+'</div></div><b>'+money(x.value)+'</b></div>').join(''):'<div class="empty">Everything has sold recently.</div>')+'</div>':lock('Slow-moving stock'));
})}
actions.rpPreset=el=>{RP.preset=el.dataset.v;if(RP.preset==='custom'){const r=rpRange();RP.from=r.from;RP.to=r.to}renderReports()};
actions.rpExport=()=>{
  const s=RP.sales,i=RP.inv;if(!s){toast('Nothing to export yet');return}
  if(s.level!=='full'){toast('CSV export is included in the Growth plan');return}
  const t=s.totals,rows=[['BOLTIV Business Manager',S.detail.business.name],['Report period',s.range.from+' to '+s.range.to],[],['SUMMARY',''],['Sales',t.count],['Total',t.total],['Average sale',t.average],['Discounts',t.discount],['Sold on credit',t.credit],['Voided',t.voided],[],['DAY','Sales','Total']].concat(s.daily.map(d=>[d.day,d.count,d.total]),
    [[],['PAYMENT METHOD','Amount']],s.methods.map(m=>[m.method,m.amount]),[[],['TOP PRODUCTS','Qty','Revenue','Profit']],s.topProducts.map(p=>[p.name,p.qty,p.revenue,p.profit]),[[],['CATEGORY','Qty','Revenue']],(s.byCategory||[]).map(c=>[c.name,c.qty,c.revenue]),[[],['CASHIER','Sales','Total']],(s.byCashier||[]).map(c=>[c.name,c.count,c.total]),
    [[],['BRANCH','Sales','Total']],(s.byBranch||[]).map(c=>[c.name,c.count,c.total]),[[],['CUSTOMER','Sales','Total']],(s.topCustomers||[]).map(c=>[c.name,c.count,c.total]),[[],['STOCK BY BRANCH','Items','Cost value','Retail value']],i.valuation.map(v=>[v.branch,v.items,v.cost,v.retail]),[[],['NOT SELLING (60 DAYS)','Qty','Value at cost']],(i.deadStock||[]).map(x=>[x.name,x.qty,x.value]));
  download('boltiv-report-'+s.range.from+'-to-'+s.range.to+'.csv',rows);
};
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.id==='rp_branch'){RP.branch=t.value;loadReports()}
  else if(t.id==='rp_from'||t.id==='rp_to'){RP.from=$('#rp_from').value;RP.to=$('#rp_to').value;if(RP.from&&RP.to)loadReports()}
});

/* ================= register tabs ================= */
BM.addTab('stocktools','Stock tools',ICON.stocktools,'inventory.view',renderStockTools,'stock');
BM.addTab('appointments','Appointments',ICON.appointments,'appointments.view',renderAppointments,'sales');
BM.addTab('reports','Reports',ICON.reports,'reports.view',renderReports,'finance');
BM.addTab('staff','Staff',ICON.staff,'staff.view',renderStaff,'reports');
BM.refresh();
})();
