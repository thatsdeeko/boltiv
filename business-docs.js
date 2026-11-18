/* BOLTIV Business Manager: premium receipt & invoice pictures.
   Draws the receipt / invoice onto a canvas so it can be shared to WhatsApp as a real picture
   (not plain text), saved as a PNG, or printed. No external libraries or network calls. */
(function(){
'use strict';
const FONT='Inter,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
const C={ink:'#15130d',mut:'#7a7568',line:'#eadfba',hair:'#f1ead2',gold:'#c99f16',gold2:'#e1bf43',deep:'#8d6907',ok:'#1f8a4c',warn:'#b7791f',bad:'#c0392b',grey:'#7b7f87'};
const fmt=v=>'₦'+Number(v||0).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2});
const day=v=>v?new Date(v).toLocaleDateString('en-NG',{day:'numeric',month:'short',year:'numeric'}):'—';
const stamp=v=>v?new Date(v).toLocaleString('en-NG',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
const cap=s=>{s=String(s||'');return s.charAt(0).toUpperCase()+s.slice(1)};
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let logoP=null;
function loadLogo(){
  if(!logoP)logoP=new Promise(res=>{const i=new Image();i.onload=()=>res(i);i.onerror=()=>res(null);i.src='assets/boltiv-logo-dark-2.webp'});
  return logoP;
}

/* ---------- drawing helpers ---------- */
function setFont(ctx,weight,size){ctx.font=weight+' '+size+'px '+FONT}
function spacing(ctx,px){if('letterSpacing' in ctx)ctx.letterSpacing=px+'px'}
function rgba(hex,a){const n=parseInt(hex.slice(1),16);return 'rgba('+(n>>16&255)+','+(n>>8&255)+','+(n&255)+','+a+')'}
function rr(ctx,x,y,w,h,r){r=Math.max(0,Math.min(r,w/2,h/2));ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}
function txt(ctx,s,x,y,o){
  o=o||{};setFont(ctx,o.w||'500',o.s||13);ctx.fillStyle=o.c||C.ink;ctx.textAlign=o.a||'left';ctx.textBaseline=o.b||'top';
  spacing(ctx,o.sp||0);ctx.fillText(String(s),x,y);spacing(ctx,0);
}
function wrap(ctx,text,maxW,maxLines){
  const words=String(text==null?'':text).split(/\s+/).filter(Boolean),lines=[];let cur='';
  for(const w of words){
    const t=cur?cur+' '+w:w;
    if(ctx.measureText(t).width<=maxW){cur=t;continue}
    if(cur){lines.push(cur);cur=''}
    if(ctx.measureText(w).width>maxW){let part='';for(const ch of w){if(ctx.measureText(part+ch).width>maxW&&part){lines.push(part);part=ch}else part+=ch}cur=part}else cur=w;
  }
  if(cur)lines.push(cur);
  if(!lines.length)lines.push('');
  if(maxLines&&lines.length>maxLines){lines.length=maxLines;let l=lines[maxLines-1];while(l.length>1&&ctx.measureText(l+'…').width>maxW)l=l.slice(0,-1);lines[maxLines-1]=l+'…'}
  return lines;
}
function goldGrad(ctx,x,y,w,h){const g=ctx.createLinearGradient(x,y,x+w,y+h);g.addColorStop(0,C.gold2);g.addColorStop(1,C.gold);return g}
function initials(n){const p=String(n||'B').replace(/[^A-Za-z0-9 ]/g,' ').split(/\s+/).filter(Boolean);return ((p[0]||'B').charAt(0)+(p[1]?p[1].charAt(0):'')).toUpperCase()}
function monogram(ctx,name,cx,cy,r){
  ctx.save();ctx.shadowColor='rgba(201,159,22,.45)';ctx.shadowBlur=14;ctx.fillStyle=goldGrad(ctx,cx-r,cy-r,r*2,r*2);ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();ctx.restore();
  txt(ctx,initials(name),cx,cy+1,{s:Math.round(r*.78),w:'800',c:'#1b1503',a:'center',b:'middle',sp:.5});
}
function chip(ctx,text,color,x,y,align){
  setFont(ctx,'800',11);spacing(ctx,1);const tw=ctx.measureText(text).width;spacing(ctx,0);
  const w=tw+34,h=26;let l=x;if(align==='center')l=x-w/2;else if(align==='right')l=x-w;
  rr(ctx,l,y,w,h,13);ctx.fillStyle=rgba(color,.12);ctx.fill();ctx.lineWidth=1;ctx.strokeStyle=rgba(color,.4);ctx.stroke();
  ctx.fillStyle=color;ctx.beginPath();ctx.arc(l+14,y+h/2,3,0,Math.PI*2);ctx.fill();
  txt(ctx,text,l+24,y+h/2+.5,{s:11,w:'800',c:color,b:'middle',sp:1});
  return {w,h};
}
function poweredBy(ctx,logo,midX,y){
  setFont(ctx,'600',11);const t='Powered by BOLTIV',tw=ctx.measureText(t).width;
  const lh=20,lw=logo?Math.round(lh*(logo.naturalWidth/logo.naturalHeight)):0,gap=logo?8:0,total=lw+gap+tw;let x=midX-total/2;
  if(logo){ctx.drawImage(logo,x,y,lw,lh);x+=lw+gap}
  txt(ctx,t,x,y+lh/2+.5,{s:11,w:'600',c:C.mut,b:'middle',sp:.3});
  return lh;
}
function watermark(ctx,text,color,cx,cy,size){
  ctx.save();ctx.translate(cx,cy);ctx.rotate(-0.42);setFont(ctx,'900',size);spacing(ctx,6);ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillStyle=rgba(color,.1);ctx.fillText(text,0,0);ctx.lineWidth=3;ctx.strokeStyle=rgba(color,.16);ctx.strokeText(text,0,0);spacing(ctx,0);ctx.restore();
}
function hairline(ctx,x1,x2,y,color,dash){ctx.save();ctx.strokeStyle=color||C.hair;ctx.lineWidth=1;if(dash)ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(x1,y+.5);ctx.lineTo(x2,y+.5);ctx.stroke();ctx.restore()}
function darkHeader(ctx,x,y,w,h){
  const g=ctx.createLinearGradient(x,y,x+w,y+h);g.addColorStop(0,'#0b0d12');g.addColorStop(.6,'#14161d');g.addColorStop(1,'#1d180b');ctx.fillStyle=g;ctx.fillRect(x,y,w,h);
  const r=ctx.createRadialGradient(x+w,y,0,x+w,y,Math.max(w*.6,240));r.addColorStop(0,'rgba(225,191,67,.42)');r.addColorStop(1,'rgba(225,191,67,0)');ctx.fillStyle=r;ctx.fillRect(x,y,w,h);
  const b=ctx.createLinearGradient(x,0,x+w,0);b.addColorStop(0,C.gold2);b.addColorStop(.55,C.gold);b.addColorStop(1,'rgba(201,159,22,0)');ctx.fillStyle=b;ctx.fillRect(x,y+h-3,w,3);
}
function cardBase(ctx,cx,top,cw,ch,o){
  ctx.fillStyle=o.outer;ctx.fillRect(0,0,cx*2+cw,top*2+ch);
  ctx.save();if(!o.bare){ctx.shadowColor='rgba(60,45,0,.2)';ctx.shadowBlur=26;ctx.shadowOffsetY=8}
  ctx.fillStyle='#ffffff';rr(ctx,cx,top,cw,ch,o.bare?0:22);ctx.fill();ctx.restore();
  ctx.save();rr(ctx,cx,top,cw,ch,o.bare?0:22);ctx.clip();
}
function scallop(ctx,cx,cw,bottom,o){
  if(o.bare)return;ctx.fillStyle=o.outer;
  for(let x=cx+16;x<cx+cw-8;x+=20){ctx.beginPath();ctx.arc(x,bottom,6.5,0,Math.PI*2);ctx.fill()}
}
function row(ctx,label,value,x,xr,y,o){
  o=o||{};txt(ctx,label,x,y,{s:o.ls||13,w:o.lw||'500',c:o.lc||C.mut});txt(ctx,value,xr,y,{s:o.vs||13,w:o.vw||'700',c:o.vc||C.ink,a:'right'});return (o.h||24);
}

/* ======================= RECEIPT ======================= */
function layoutReceipt(ctx,s,h,logo,H,o){
  const W=600,P=o.pad,cx=P,cw=W-2*P,ip=28,x0=cx+ip,iw=cw-2*ip,xr=x0+iw,top=P,isVoid=s.status==='void';
  /* measure header */
  setFont(ctx,'800',21);const nameL=wrap(ctx,h.name||'Business',iw-66,2);
  setFont(ctx,'500',12);const infoL=wrap(ctx,[h.address,h.phone].filter(Boolean).join('  ·  '),iw-66,2);
  const tinL=h.tin?'TIN: '+h.tin:'';
  const blockH=Math.max(48,nameL.length*26+(infoL.length+(tinL?1:0))*17+4);
  const headH=28+blockH+18+26+28;
  cardBase(ctx,cx,top,cw,H-2*P,o);
  darkHeader(ctx,cx,top,cw,headH);
  monogram(ctx,h.name,x0+24,top+28+24,24);
  let ty=top+28;
  nameL.forEach(l=>{txt(ctx,l,x0+64,ty,{s:21,w:'800',c:'#ffffff'});ty+=26});
  infoL.forEach(l=>{txt(ctx,l,x0+64,ty,{s:12,c:'rgba(255,255,255,.66)'});ty+=17});
  if(tinL){txt(ctx,tinL,x0+64,ty,{s:12,c:'rgba(255,255,255,.66)'})}
  /* receipt pill */
  const py=top+28+blockH+18;setFont(ctx,'800',11);spacing(ctx,2.2);const pw=ctx.measureText('PAYMENT RECEIPT').width+30;spacing(ctx,0);
  rr(ctx,x0,py,pw,26,13);ctx.fillStyle='rgba(225,191,67,.16)';ctx.fill();ctx.strokeStyle='rgba(225,191,67,.6)';ctx.lineWidth=1;ctx.stroke();
  txt(ctx,'PAYMENT RECEIPT',x0+15,py+13.5,{s:11,w:'800',c:C.gold2,b:'middle',sp:2.2});
  let y=top+headH+34;
  /* amount */
  txt(ctx,isVoid?'TOTAL (VOIDED)':'TOTAL AMOUNT',cx+cw/2,y,{s:11,w:'700',c:C.mut,a:'center',sp:2});y+=22;
  txt(ctx,fmt(s.total),cx+cw/2,y,{s:42,w:'800',c:isVoid?C.grey:C.ink,a:'center',sp:-.5});y+=58;
  const st=isVoid?{t:'VOIDED',c:C.bad}:(s.balanceDue>0?{t:'BALANCE DUE '+fmt(s.balanceDue),c:C.warn}:{t:'PAID IN FULL',c:C.ok});
  chip(ctx,st.t,st.c,cx+cw/2,y,'center');y+=26+30;
  /* tear line */
  hairline(ctx,cx+20,cx+cw-20,y,'#d9cd9e',[5,5]);
  if(!o.bare){ctx.fillStyle=o.outer;[cx,cx+cw].forEach(px=>{ctx.beginPath();ctx.arc(px,y+.5,12,0,Math.PI*2);ctx.fill()})}
  y+=28;
  /* meta grid */
  const meta=[['RECEIPT NO',s.receiptNo],['DATE',stamp(s.createdAt)],['BRANCH',s.branchName],['SERVED BY',s.cashier],['CUSTOMER',s.customerName],['PHONE',s.customerPhone]].filter(m=>m[1]);
  const colW=iw/2;
  for(let i=0;i<meta.length;i+=2){
    let rh=0;
    [meta[i],meta[i+1]].forEach((m,k)=>{if(!m)return;const x=x0+k*colW;txt(ctx,m[0],x,y,{s:10,w:'700',c:C.mut,sp:1.3});
      setFont(ctx,'700',13.5);const ls=wrap(ctx,m[1],colW-14,2);ls.forEach((l,j)=>txt(ctx,l,x,y+16+j*18,{s:13.5,w:'700',c:C.ink}));rh=Math.max(rh,16+ls.length*18)});
    y+=rh+14;
  }
  y+=4;hairline(ctx,x0,xr,y,C.line);y+=18;
  /* items */
  txt(ctx,'ITEMS',x0,y,{s:10,w:'700',c:C.mut,sp:1.3});txt(ctx,'AMOUNT',xr,y,{s:10,w:'700',c:C.mut,a:'right',sp:1.3});y+=22;
  (s.items||[]).forEach((it,idx)=>{
    setFont(ctx,'700',14);const ls=wrap(ctx,it.name,iw-120,3);
    ls.forEach((l,j)=>txt(ctx,l,x0,y+j*19,{s:14,w:'700',c:C.ink}));
    txt(ctx,fmt(it.lineTotal),xr,y,{s:14,w:'700',c:C.ink,a:'right'});
    const sy=y+ls.length*19+1;txt(ctx,it.qty+' × '+fmt(it.unitPrice),x0,sy,{s:12,c:C.mut});
    y=sy+22;if(idx<(s.items||[]).length-1){hairline(ctx,x0,xr,y-8,C.hair);}
  });
  y+=6;hairline(ctx,x0,xr,y,C.line);y+=18;
  /* totals */
  y+=row(ctx,'Subtotal',fmt(s.subtotal),x0,xr,y);
  if(s.discount>0)y+=row(ctx,'Discount','−'+fmt(s.discount),x0,xr,y,{vc:C.ok});
  if(s.vatRate>0)y+=row(ctx,'VAT '+s.vatRate+'%'+(s.vatInclusive?' (incl.)':''),fmt(s.tax),x0,xr,y);
  y+=6;
  rr(ctx,x0-10,y,iw+20,50,14);const bg=ctx.createLinearGradient(x0,y,xr,y+50);bg.addColorStop(0,'#fbf3d3');bg.addColorStop(1,'#f4e3a0');ctx.fillStyle=bg;ctx.fill();ctx.strokeStyle='rgba(201,159,22,.45)';ctx.lineWidth=1;ctx.stroke();
  txt(ctx,'TOTAL',x0+6,y+25,{s:13,w:'800',c:C.deep,b:'middle',sp:2});txt(ctx,fmt(s.total),xr-6,y+25,{s:22,w:'800',c:C.ink,a:'right',b:'middle'});
  y+=50+20;
  /* payments */
  if((s.payments||[]).length){txt(ctx,'PAYMENT',x0,y,{s:10,w:'700',c:C.mut,sp:1.3});y+=20;
    s.payments.forEach(p=>{y+=row(ctx,cap(p.method),fmt(p.amount),x0,xr,y,{lc:C.ink,lw:'600'})})}
  if(s.change>0)y+=row(ctx,'Change given',fmt(s.change),x0,xr,y);
  if(s.balanceDue>0&&!isVoid){y+=4;y+=row(ctx,'Balance owed',fmt(s.balanceDue),x0,xr,y,{lc:C.warn,lw:'800',vc:C.warn,vw:'800',vs:15,h:28})}
  /* footer */
  y+=14;hairline(ctx,x0,xr,y,'#d9cd9e',[5,5]);y+=22;
  setFont(ctx,'600',13);wrap(ctx,h.footer||'Thank you for your patronage!',iw-30,3).forEach(l=>{txt(ctx,l,cx+cw/2,y,{s:13,w:'600',c:C.ink,a:'center'});y+=19});
  y+=14;poweredBy(ctx,logo,cx+cw/2,y);y+=20;
  y+=30;
  if(isVoid)watermark(ctx,'VOIDED',C.bad,cx+cw/2,top+(y-top)*.5,96);
  ctx.restore();
  scallop(ctx,cx,cw,y,o);
  return y;
}

/* ======================= INVOICE ======================= */
function invStatus(inv){
  const st=String(inv.status||'').toLowerCase();
  if(st==='paid')return {t:'PAID',c:C.ok,m:'PAID'};
  if(st==='void')return {t:'VOID',c:C.bad,m:'VOID'};
  if(st==='draft')return {t:'DRAFT',c:C.grey,m:'DRAFT'};
  if(st==='overdue')return {t:'OVERDUE',c:C.bad,m:''};
  if(st==='partial')return {t:'PART PAID',c:C.warn,m:''};
  if(st==='unpaid')return {t:'UNPAID',c:C.warn,m:''};
  return {t:st?st.toUpperCase():'INVOICE',c:C.warn,m:''};
}
function layoutInvoice(ctx,inv,b,logo,H,o){
  const W=820,P=o.pad,cx=P,cw=W-2*P,ip=38,x0=cx+ip,iw=cw-2*ip,xr=x0+iw,top=P,sv=invStatus(inv);
  const rightW=240;
  setFont(ctx,'800',24);const nameL=wrap(ctx,b.name||'Business',iw-rightW-72,2);
  setFont(ctx,'500',12.5);const infoL=wrap(ctx,[b.address,b.phone,b.email].filter(Boolean).join('  ·  '),iw-rightW-72,3);
  const tinL=b.tin?'TIN: '+b.tin:'';
  const textH=Math.max(52,nameL.length*30+(infoL.length+(tinL?1:0))*18+4);
  const headH=36+Math.max(textH,104)+32;
  cardBase(ctx,cx,top,cw,H-2*P,o);
  darkHeader(ctx,cx,top,cw,headH);
  monogram(ctx,b.name,x0+26,top+36+26,26);
  let ty=top+36;
  nameL.forEach(l=>{txt(ctx,l,x0+70,ty,{s:24,w:'800',c:'#ffffff'});ty+=30});
  infoL.forEach(l=>{txt(ctx,l,x0+70,ty,{s:12.5,c:'rgba(255,255,255,.66)'});ty+=18});
  if(tinL)txt(ctx,tinL,x0+70,ty,{s:12.5,c:'rgba(255,255,255,.66)'});
  txt(ctx,'INVOICE',xr,top+34,{s:34,w:'800',c:C.gold2,a:'right',sp:4});
  txt(ctx,inv.invoiceNo||'DRAFT',xr,top+78,{s:16,w:'700',c:'#ffffff',a:'right'});
  txt(ctx,'Issued '+day(inv.issueDate),xr,top+102,{s:12.5,c:'rgba(255,255,255,.66)',a:'right'});
  txt(ctx,'Due '+day(inv.dueDate),xr,top+120,{s:12.5,c:'rgba(255,255,255,.66)',a:'right'});
  let y=top+headH+28;
  /* bill-to panel */
  setFont(ctx,'800',18);const cl=wrap(ctx,inv.customerName||'Customer',iw/2-30,2);
  const contact=[inv.customerPhone,inv.customerEmail].filter(Boolean);
  const leftH=18+cl.length*24+contact.length*18;const rightH=18+36+30;const panelH=Math.max(leftH,rightH)+34;
  rr(ctx,x0-14,y,iw+28,panelH,18);ctx.fillStyle='#fbf7e8';ctx.fill();ctx.strokeStyle='#efe3b8';ctx.lineWidth=1;ctx.stroke();
  txt(ctx,'BILLED TO',x0+4,y+18,{s:10,w:'700',c:C.mut,sp:1.4});
  let ly=y+38;cl.forEach(l=>{txt(ctx,l,x0+4,ly,{s:18,w:'800',c:C.ink});ly+=24});
  contact.forEach(l=>{txt(ctx,l,x0+4,ly,{s:12.5,c:C.mut});ly+=18});
  const showTotal=sv.m!==''||inv.balanceDue==null||sv.t==='INVOICE';
  const amt=showTotal?inv.total:inv.balanceDue;
  txt(ctx,sv.t==='PAID'?'TOTAL PAID':(showTotal?'TOTAL':'AMOUNT DUE'),xr-4,y+18,{s:10,w:'700',c:C.mut,a:'right',sp:1.4});
  txt(ctx,fmt(amt),xr-4,y+34,{s:30,w:'800',c:sv.t==='VOID'?C.grey:C.deep,a:'right'});
  chip(ctx,sv.t,sv.c,xr-4,y+74,'right');
  y+=panelH+30;
  /* table */
  const cQ=xr-300,cP=xr-170;
  rr(ctx,x0-14,y,iw+28,36,10);ctx.fillStyle='#14161d';ctx.fill();
  const hy=y+18;txt(ctx,'DESCRIPTION',x0+4,hy,{s:10.5,w:'800',c:C.gold2,b:'middle',sp:1.4});
  [['QTY',cQ],['PRICE',cP],['AMOUNT',xr-4]].forEach(c=>txt(ctx,c[0],c[1],hy,{s:10.5,w:'800',c:C.gold2,a:'right',b:'middle',sp:1.4}));
  y+=36+4;
  (inv.items||[]).forEach((it,i)=>{
    setFont(ctx,'600',14);const ls=wrap(ctx,it.description,cQ-x0-60,4);const rh=Math.max(46,ls.length*19+26);
    if(i%2===1){rr(ctx,x0-14,y,iw+28,rh,8);ctx.fillStyle='#fbf8ee';ctx.fill()}
    const my=y+(rh-ls.length*19)/2;ls.forEach((l,j)=>txt(ctx,l,x0+4,my+j*19,{s:14,w:'600',c:C.ink}));
    const cy=y+rh/2;
    txt(ctx,String(it.qty),cQ,cy,{s:13.5,w:'600',c:C.ink,a:'right',b:'middle'});
    txt(ctx,fmt(it.unitPrice),cP,cy,{s:13.5,w:'500',c:C.mut,a:'right',b:'middle'});
    txt(ctx,fmt(it.lineTotal),xr-4,cy,{s:14,w:'700',c:C.ink,a:'right',b:'middle'});
    y+=rh;
  });
  y+=20;
  /* totals */
  const tw=330,tx=xr-tw,txr=xr-4;
  y+=row(ctx,'Subtotal',fmt(inv.subtotal),tx+4,txr,y);
  if(inv.discount>0)y+=row(ctx,'Discount','−'+fmt(inv.discount),tx+4,txr,y,{vc:C.ok});
  if(inv.vatRate>0)y+=row(ctx,'VAT '+inv.vatRate+'%'+(inv.vatInclusive?' (incl.)':''),fmt(inv.tax),tx+4,txr,y);
  const hasPaid=inv.paid>0;
  if(hasPaid){hairline(ctx,tx+4,txr,y+2,C.line);y+=12;y+=row(ctx,'Total',fmt(inv.total),tx+4,txr,y,{lc:C.ink,lw:'700',vw:'800',vs:14});y+=row(ctx,'Paid','−'+fmt(inv.paid),tx+4,txr,y,{vc:C.ok})}
  y+=8;
  rr(ctx,tx-4,y,tw+8,56,14);ctx.fillStyle=goldGrad(ctx,tx,y,tw,56);ctx.fill();
  txt(ctx,hasPaid?'BALANCE DUE':'TOTAL DUE',tx+14,y+28,{s:12,w:'800',c:'#1b1503',b:'middle',sp:2});
  txt(ctx,fmt(hasPaid?inv.balanceDue:inv.total),txr-10,y+28,{s:23,w:'800',c:'#1b1503',a:'right',b:'middle'});
  y+=56+28;
  /* notes / terms */
  [['NOTES',inv.notes],['TERMS',inv.terms]].forEach(n=>{
    if(!n[1])return;setFont(ctx,'500',12.5);const ls=wrap(ctx,n[1],iw-12,7);const bh=16+14+ls.length*18+8;
    rr(ctx,x0-14,y,iw+28,bh,14);ctx.fillStyle='#fbf7e8';ctx.fill();ctx.strokeStyle='#efe3b8';ctx.lineWidth=1;ctx.stroke();
    txt(ctx,n[0],x0+4,y+14,{s:10,w:'700',c:C.mut,sp:1.4});ls.forEach((l,j)=>txt(ctx,l,x0+4,y+34+j*18,{s:12.5,c:'#4a463c'}));y+=bh+14;
  });
  /* footer */
  y+=6;const gl=ctx.createLinearGradient(x0,0,xr,0);gl.addColorStop(0,'rgba(201,159,22,0)');gl.addColorStop(.5,C.gold);gl.addColorStop(1,'rgba(201,159,22,0)');ctx.fillStyle=gl;ctx.fillRect(x0,y,iw,2);y+=22;
  txt(ctx,'Thank you for your business.',cx+cw/2,y,{s:14,w:'700',c:C.ink,a:'center'});y+=26;
  poweredBy(ctx,logo,cx+cw/2,y);y+=20;y+=30;
  if(sv.m)watermark(ctx,sv.m,sv.c,cx+cw/2,top+(y-top)*.55,130);
  ctx.restore();
  scallop(ctx,cx,cw,y,o);
  return y;
}

/* ======================= render / share ======================= */
async function render(type,data,biz,opts){
  opts=opts||{};const logo=await loadLogo();
  const inv=type==='invoice',W=inv?820:600;
  const o={pad:opts.bare?0:(inv?28:24),bare:!!opts.bare,outer:opts.bare?'#ffffff':'#f3ecd5'};
  const lay=inv?layoutInvoice:layoutReceipt;
  const probe=document.createElement('canvas');probe.width=probe.height=8;
  const end=lay(probe.getContext('2d'),data,biz,logo,4000,o);
  const H=Math.ceil(end+o.pad);
  let k=2;while(k>1&&W*k*H*k>14e6)k-=.25;
  const cv=document.createElement('canvas');cv.width=Math.round(W*k);cv.height=Math.round(H*k);
  const ctx=cv.getContext('2d');ctx.scale(k,k);
  lay(ctx,data,biz,logo,H,o);
  const blob=await new Promise((res,rej)=>cv.toBlob(b=>b?res(b):rej(new Error('Could not create the picture')),'image/png'));
  return {canvas:cv,blob,w:W,h:H};
}
function save(blob,name){
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1500);
}
/* On phones this opens the share sheet with the PICTURE attached (WhatsApp is listed there).
   Where the browser cannot share files (most desktops) we save the picture and open WhatsApp. */
async function share(blob,name,text,phone){
  try{
    const file=new File([blob],name,{type:'image/png'});
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      try{await navigator.share({files:[file],title:name.replace(/\.png$/,''),text:text});return 'shared'}
      catch(e){if(e&&e.name==='AbortError')return 'cancelled'}
    }
  }catch(e){}
  save(blob,name);
  window.open('https://wa.me/'+(phone||'')+'?text='+encodeURIComponent(text),'_blank','noopener');
  return 'fallback';
}

const BDOC={render,share,save,cur:null,url:null,seq:0};
const sty=document.createElement('style');
sty.textContent='.docprev{margin:12px 0;border-radius:16px;overflow:auto;max-height:54vh;background:#f3ecd5;-webkit-overflow-scrolling:touch}.docprev img{display:block;width:100%;height:auto}.docprev .dp-wait{padding:44px 12px;text-align:center;font-size:13px;opacity:.7}';
document.head.appendChild(sty);
BDOC.WAIT='<div class="dp-wait">Preparing your picture…</div>';

/* Draw the document and drop it into the open sheet (#docPrev). */
BDOC.mount=async function(type,data,biz,meta){
  const id=++BDOC.seq;BDOC.cur=null;BDOC.last={type,data,biz,meta};
  let r;
  try{r=await render(type,data,biz)}
  catch(e){const el=document.getElementById('docPrev');if(el&&id===BDOC.seq)el.innerHTML='<div class="dp-wait">Could not draw the picture on this device. You can still print it.</div>';return}
  if(id!==BDOC.seq)return;
  const el=document.getElementById('docPrev');if(!el)return;
  if(BDOC.url)URL.revokeObjectURL(BDOC.url);
  BDOC.url=URL.createObjectURL(r.blob);
  BDOC.cur={type,data,biz,meta,blob:r.blob};
  el.innerHTML='<img alt="'+esc(meta.name)+'" src="'+BDOC.url+'">';
};

window.BDOC=BDOC;
window.addEventListener('load',function(){
  const B=window.BM;if(!B||!B.actions)return;
  const actions=B.actions,toast=B.toast;
  actions.shareDoc=async()=>{
    const c=BDOC.cur;if(!c){toast('Still preparing the picture…');return}
    const r=await share(c.blob,c.meta.name,c.meta.text,c.meta.phone);
    if(r==='fallback')toast('Picture saved. Attach it in the WhatsApp chat that just opened.');
  };
  actions.saveDoc=()=>{const c=BDOC.cur;if(!c){toast('Still preparing the picture…');return}save(c.blob,c.meta.name);toast('Picture saved.')};
  /* Invoice print / PDF now uses the same premium design, on plain white paper. */
  actions.ivPrint=async()=>{
    const q=BDOC.last;if(!q||q.type!=='invoice')return;
    let r;try{r=await render('invoice',q.data,q.biz,{bare:true})}catch(e){toast('Could not prepare the print.');return}
    const url=r.canvas.toDataURL('image/png');
    const f=document.createElement('iframe');f.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0';document.body.appendChild(f);
    const d=f.contentWindow.document;d.open();
    d.write('<!doctype html><html><head><meta charset="utf-8"><title>'+esc(q.data.invoiceNo||'Invoice')+'</title><style>@page{margin:8mm}html,body{margin:0;background:#fff}img{display:block;width:100%;height:auto}</style></head><body><img src="'+url+'"></body></html>');d.close();
    const img=d.querySelector('img');
    const go=()=>setTimeout(()=>{try{f.contentWindow.focus();f.contentWindow.print()}catch(e){}setTimeout(()=>f.remove(),2500)},200);
    if(img.complete)go();else img.onload=go;
  };
});
})();
