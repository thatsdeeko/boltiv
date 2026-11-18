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

const imgCache={};
function loadImg(src){if(!src)return Promise.resolve(null);if(!imgCache[src])imgCache[src]=new Promise(res=>{const i=new Image();i.onload=()=>res(i);i.onerror=()=>res(null);i.src=src});return imgCache[src]}
let logoP=null;
function loadLogo(){
  if(!logoP)logoP=new Promise(res=>{const i=new Image();i.onload=()=>res(i);i.onerror=()=>res(null);i.src='assets/boltiv-logo-dark-2.webp'});
  return logoP;
}

/* ---------- drawing helpers ---------- */
function setFont(ctx,weight,size,style){ctx.font=(style?style+' ':'')+weight+' '+size+'px '+FONT}
function spacing(ctx,px){if('letterSpacing' in ctx)ctx.letterSpacing=px+'px'}
function rgba(hex,a){const n=parseInt(hex.slice(1),16);return 'rgba('+(n>>16&255)+','+(n>>8&255)+','+(n&255)+','+a+')'}
function rr(ctx,x,y,w,h,r){r=Math.max(0,Math.min(r,w/2,h/2));ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}
function rrTop(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x,y+h);ctx.lineTo(x,y+r);ctx.arcTo(x,y,x+r,y,r);ctx.lineTo(x+w-r,y);ctx.arcTo(x+w,y,x+w,y+r,r);ctx.lineTo(x+w,y+h);ctx.closePath()}
function rrBottom(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+w,y);ctx.lineTo(x+w,y+h-r);ctx.arcTo(x+w,y+h,x+w-r,y+h,r);ctx.lineTo(x+r,y+h);ctx.arcTo(x,y+h,x,y+h-r,r);ctx.closePath()}
function txt(ctx,s,x,y,o){
  o=o||{};setFont(ctx,o.w||'500',o.s||13,o.i?'italic':'');ctx.fillStyle=o.c||C.ink;ctx.textAlign=o.a||'left';ctx.textBaseline=o.b||'top';
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
function hairline(ctx,x1,x2,y,color,dash){ctx.save();ctx.strokeStyle=color||C.hair;ctx.lineWidth=1;if(dash)ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(x1,y+.5);ctx.lineTo(x2,y+.5);ctx.stroke();ctx.restore()}
/* 24x24 line icons */
const ICO={
  pin:'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 7.2a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z',
  phone:'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  receipt:'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  calendar:'M4 6h16v14H4zM8 3v4M16 3v4M4 10h16',
  person:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 21c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5',
  card:'M3 6h18v12H3zM3 10h18M7 15h3',
  clock:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  check:'M5 12.5l4.5 4.5L19 7.5'
};
function icon(ctx,name,x,y,size,color,lw){
  ctx.save();ctx.translate(x,y);ctx.scale(size/24,size/24);ctx.strokeStyle=color;ctx.lineWidth=lw||1.8;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke(new Path2D(ICO[name]));ctx.restore();
}
function drawLogo(ctx,o,name,cx,cy,r){
  const img=o.blogo;
  if(img){
    ctx.save();ctx.shadowColor='rgba(201,159,22,.45)';ctx.shadowBlur=14;ctx.fillStyle='#ffffff';ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();ctx.restore();
    ctx.save();ctx.beginPath();ctx.arc(cx,cy,r-3,0,Math.PI*2);ctx.clip();
    const box=(r-3)*2*.9,sc=Math.min(box/img.naturalWidth,box/img.naturalHeight),w=img.naturalWidth*sc,h=img.naturalHeight*sc;
    ctx.drawImage(img,cx-w/2,cy-h/2,w,h);ctx.restore();
    ctx.lineWidth=3;ctx.strokeStyle=goldGrad(ctx,cx-r,cy-r,r*2,r*2);ctx.beginPath();ctx.arc(cx,cy,r-1.5,0,Math.PI*2);ctx.stroke();
  }else{
    ctx.save();ctx.shadowColor='rgba(201,159,22,.45)';ctx.shadowBlur=14;ctx.fillStyle=goldGrad(ctx,cx-r,cy-r,r*2,r*2);ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();ctx.restore();
    txt(ctx,initials(name),cx,cy+1,{s:Math.round(r*.8),w:'800',c:'#1b1503',a:'center',b:'middle',sp:.5});
  }
}
function poly(ctx,pts){ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath()}
function swoosh(ctx,x,y,w,h){
  ctx.save();ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();
  ctx.fillStyle='rgba(255,255,255,.05)';poly(ctx,[[x+w*.62,y+h],[x+w*.86,y],[x+w,y],[x+w,y+h]]);ctx.fill();
  const g=ctx.createLinearGradient(x+w*.7,y+h,x+w,y);g.addColorStop(0,'#8d6907');g.addColorStop(.5,C.gold2);g.addColorStop(1,'#f5dc7a');
  ctx.fillStyle=g;poly(ctx,[[x+w*.80,y+h],[x+w*.925,y],[x+w*.965,y],[x+w*.845,y+h]]);ctx.fill();
  ctx.globalAlpha=.75;poly(ctx,[[x+w*.865,y+h],[x+w*.972,y],[x+w*.984,y],[x+w*.876,y+h]]);ctx.fill();ctx.globalAlpha=1;
  const c=ctx.createLinearGradient(x+w*.75,y+h,x+w,y+h-30);c.addColorStop(0,'rgba(201,159,22,0)');c.addColorStop(1,C.gold2);
  ctx.fillStyle=c;ctx.beginPath();ctx.moveTo(x+w*.74,y+h);ctx.bezierCurveTo(x+w*.88,y+h-2,x+w*.95,y+h-12,x+w,y+h-34);ctx.lineTo(x+w,y+h);ctx.closePath();ctx.fill();
  ctx.restore();
}
function bottomWave(ctx,x,y,w,h){
  ctx.save();ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();
  const g=ctx.createLinearGradient(x,y,x+w,y);g.addColorStop(0,C.gold2);g.addColorStop(.3,'#a67f0e');g.addColorStop(.7,'#a67f0e');g.addColorStop(1,C.gold2);
  ctx.fillStyle=g;ctx.beginPath();ctx.moveTo(x,y+h*.25);ctx.bezierCurveTo(x+w*.18,y+h*.2,x+w*.28,y+h*.7,x+w*.5,y+h*.78);ctx.bezierCurveTo(x+w*.72,y+h*.7,x+w*.82,y+h*.2,x+w,y+h*.25);ctx.lineTo(x+w,y+h);ctx.lineTo(x,y+h);ctx.closePath();ctx.fill();
  const d=ctx.createLinearGradient(x,y,x+w,y+h);d.addColorStop(0,'#0b0d12');d.addColorStop(1,'#1a160a');
  ctx.fillStyle=d;ctx.beginPath();ctx.moveTo(x,y+h*.52);ctx.bezierCurveTo(x+w*.2,y+h*.42,x+w*.3,y+h*.9,x+w*.5,y+h*.95);ctx.bezierCurveTo(x+w*.7,y+h*.9,x+w*.8,y+h*.42,x+w,y+h*.52);ctx.lineTo(x+w,y+h);ctx.lineTo(x,y+h);ctx.closePath();ctx.fill();
  ctx.restore();
}
function darkHeader(ctx,x,y,w,h){
  const g=ctx.createLinearGradient(x,y,x+w,y+h);g.addColorStop(0,'#08090d');g.addColorStop(.65,'#12141a');g.addColorStop(1,'#1c170a');ctx.fillStyle=g;ctx.fillRect(x,y,w,h);
  swoosh(ctx,x,y,w,h);
}
function cardBase(ctx,cx,top,cw,ch,o){
  ctx.fillStyle=o.outer;ctx.fillRect(0,0,cx*2+cw,top*2+ch);
  ctx.save();if(!o.bare){ctx.shadowColor='rgba(40,30,0,.22)';ctx.shadowBlur=26;ctx.shadowOffsetY=8}
  ctx.fillStyle='#ffffff';rr(ctx,cx,top,cw,ch,o.bare?0:24);ctx.fill();ctx.restore();
  ctx.save();rr(ctx,cx,top,cw,ch,o.bare?0:24);ctx.clip();
}
/* Header: logo | divider | name + address + phone. Returns its height. */
function header(ctx,o,cx,top,cw,name,addr,phone,tin,email,big){
  const r=big?38:36,lx=cx+28+r,maxW=cw*.78-(r*2+28+32)-12,nameSz=big?24:21,nameLh=nameSz+5;
  setFont(ctx,'800',nameSz);const nameL=wrap(ctx,name||'Business',maxW,2);
  setFont(ctx,'500',12.5);const addrL=addr?wrap(ctx,addr,maxW-20,2):[];const lines=[];
  addrL.forEach((l,i)=>lines.push({t:l,ic:i?null:'pin'}));
  if(phone)lines.push({t:phone,ic:'phone'});
  if(email)lines.push({t:email,ic:null});
  if(tin)lines.push({t:'TIN: '+tin,ic:null});
  const blockH=nameL.length*nameLh+4+lines.length*19,hh=Math.max(r*2+52,blockH+52);
  darkHeader(ctx,cx,top,cw,hh);
  const cy=top+hh/2;drawLogo(ctx,o,name,lx,cy,r);
  const dx=lx+r+16;const dg=ctx.createLinearGradient(0,cy-r,0,cy+r);dg.addColorStop(0,'rgba(225,191,67,0)');dg.addColorStop(.5,'rgba(225,191,67,.8)');dg.addColorStop(1,'rgba(225,191,67,0)');
  ctx.fillStyle=dg;ctx.fillRect(dx,cy-r,1.5,r*2);
  const tx=dx+18;let ty=cy-blockH/2;
  nameL.forEach(l=>{txt(ctx,l,tx,ty,{s:nameSz,w:'800',c:'#ffffff'});ty+=nameLh});ty+=4;
  lines.forEach(l=>{if(l.ic){icon(ctx,l.ic,tx,ty+1,15,C.gold2,2);txt(ctx,l.t,tx+22,ty,{s:12.5,c:'rgba(255,255,255,.78)'})}else txt(ctx,l.t,tx+22,ty,{s:12.5,c:'rgba(255,255,255,.78)'});ty+=19});
  return hh;
}
function titlePill(ctx,text,x0,xr,y){
  setFont(ctx,'800',14);spacing(ctx,4);const tw=ctx.measureText(text).width;spacing(ctx,0);
  const w=tw+58,h=36,mid=(x0+xr)/2,l=mid-w/2;
  hairline(ctx,x0,l-16,y+h/2,'#e3d9b8');hairline(ctx,l+w+16,xr,y+h/2,'#e3d9b8');
  rr(ctx,l,y,w,h,18);ctx.fillStyle=goldGrad(ctx,l,y,w,h);ctx.fill();
  txt(ctx,text,mid+2,y+h/2+.5,{s:14,w:'800',c:'#1b1503',a:'center',b:'middle',sp:4});
  return h;
}
function statusPill(ctx,text,color,kind,mid,y){
  setFont(ctx,'700',16);const tw=ctx.measureText(text).width,w=tw+68,h=40,l=mid-w/2;
  rr(ctx,l,y,w,h,20);ctx.fillStyle=rgba(color,.1);ctx.fill();ctx.lineWidth=1.3;ctx.strokeStyle=rgba(color,.5);ctx.stroke();
  ctx.fillStyle=color;ctx.beginPath();ctx.arc(l+26,y+h/2,12,0,Math.PI*2);ctx.fill();
  if(kind==='ok')icon(ctx,'check',l+26-8,y+h/2-8,16,'#fff',3);
  else txt(ctx,kind==='bad'?'×':'!',l+26,y+h/2+1,{s:16,w:'800',c:'#fff',a:'center',b:'middle'});
  txt(ctx,text,l+48,y+h/2+.5,{s:16,w:'700',c:color,b:'middle'});
  return h;
}
function infoCard(ctx,x,y,w,cells){
  const n=cells.length,cw=w/n;let maxL=1;
  setFont(ctx,'700',14);cells.forEach(c=>{c.lines=wrap(ctx,c.value||'—',cw-22,2);maxL=Math.max(maxL,c.lines.length)});
  const h=18+40+8+16+4+maxL*18+16;
  rr(ctx,x,y,w,h,16);ctx.fillStyle='#fbfbf9';ctx.fill();ctx.lineWidth=1;ctx.strokeStyle='#e8e6de';ctx.stroke();
  cells.forEach((c,i)=>{
    const mx=x+cw*i+cw/2;
    if(i){ctx.fillStyle='#e6e3d8';ctx.fillRect(x+cw*i,y+16,1,h-32)}
    ctx.fillStyle='#f7ecc3';ctx.beginPath();ctx.arc(mx,y+18+20,20,0,Math.PI*2);ctx.fill();
    icon(ctx,c.icon,mx-11,y+18+20-11,22,'#a77d0c',1.8);
    txt(ctx,c.label,mx,y+18+40+8,{s:12.5,c:C.mut,a:'center'});
    c.lines.forEach((l,j)=>txt(ctx,l,mx,y+18+40+8+20+j*18,{s:14,w:'700',c:C.ink,a:'center'}));
  });
  return h;
}
function totalBand(ctx,x,y,w,label,value,size){
  const h=size==='lg'?60:52;
  rr(ctx,x,y,w,h,16);const bg=ctx.createLinearGradient(x,y,x+w,y);bg.addColorStop(0,'#fdf3cf');bg.addColorStop(.55,'#f6df94');bg.addColorStop(1,'#f1d27a');ctx.fillStyle=bg;ctx.fill();ctx.strokeStyle='rgba(201,159,22,.5)';ctx.lineWidth=1;ctx.stroke();
  txt(ctx,label,x+22,y+h/2+.5,{s:size==='lg'?24:15,w:'800',c:C.ink,b:'middle',sp:size==='lg'?0:2});
  txt(ctx,value,x+w-22,y+h/2+.5,{s:size==='lg'?28:24,w:'800',c:C.ink,a:'right',b:'middle'});
  return h;
}
function footer(ctx,o,logo,cx,cw,x0,xr,y,message,small){
  setFont(ctx,'600',17,'italic');const lines=wrap(ctx,message,cw-150,2);
  lines.forEach(l=>{const tw=ctx.measureText(l).width,mid=cx+cw/2;
    hairline(ctx,x0+10,mid-tw/2-16,y+10,'#ddd5b8');hairline(ctx,mid+tw/2+16,xr-10,y+10,'#ddd5b8');
    txt(ctx,l,mid,y,{s:17,w:'600',i:true,c:C.ink,a:'center'});y+=24});
  y+=12;
  setFont(ctx,'400',14);const p1='Powered by ',w1=ctx.measureText(p1).width;setFont(ctx,'800',14);const w2=ctx.measureText('BOLTIV').width;
  const lh=26,lw=logo?Math.round(lh*(logo.naturalWidth/logo.naturalHeight)):0,gap=logo?8:0,total=lw+gap+w1+w2;let x=cx+cw/2-total/2;
  if(logo){ctx.drawImage(logo,x,y,lw,lh);x+=lw+gap}
  txt(ctx,p1,x,y+lh/2+.5,{s:14,w:'400',c:'#55524a',b:'middle'});txt(ctx,'BOLTIV',x+w1,y+lh/2+.5,{s:14,w:'800',c:C.ink,b:'middle'});
  y+=lh+(small?10:0);
  if(small){txt(ctx,small,cx+cw/2,y,{s:12,c:C.mut,a:'center'});y+=18}
  return y;
}
function watermark(ctx,text,color,cx,cy,size){
  ctx.save();ctx.translate(cx,cy);ctx.rotate(-0.42);setFont(ctx,'900',size);spacing(ctx,6);ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillStyle=rgba(color,.1);ctx.fillText(text,0,0);ctx.lineWidth=3;ctx.strokeStyle=rgba(color,.16);ctx.strokeText(text,0,0);spacing(ctx,0);ctx.restore();
}
function row(ctx,label,value,x,xr,y,o){
  o=o||{};txt(ctx,label,x,y,{s:o.ls||16,w:o.lw||'500',c:o.lc||'#6b675d'});txt(ctx,value,xr,y,{s:o.vs||16,w:o.vw||'700',c:o.vc||C.ink,a:'right'});return (o.h||30);
}
const methodsOf=p=>{const m=[];(p||[]).forEach(x=>{const k=cap(x.method);if(k&&m.indexOf(k)<0)m.push(k)});return m.join(' + ')||'—'};

/* ======================= RECEIPT ======================= */
function layoutReceipt(ctx,s,h,logo,H,o){
  const W=600,P=o.pad,cx=P,cw=W-2*P,x0=cx+20,iw=cw-40,xr=x0+iw,top=P,isVoid=s.status==='void',WAVE=70;
  cardBase(ctx,cx,top,cw,H-2*P,o);
  const hh=header(ctx,o,cx,top,cw,h.name,h.address,h.phone,h.tin,'',false);
  let y=top+hh+22;
  y+=titlePill(ctx,'SALES RECEIPT',x0+6,xr-6,y)+22;
  const paid=isVoid?s.total:Math.max(0,(s.total||0)-(s.balanceDue||0));
  txt(ctx,isVoid?'TOTAL (VOIDED)':'AMOUNT PAID',cx+cw/2,y,{s:15,w:'700',c:C.ink,a:'center',sp:5});y+=28;
  txt(ctx,fmt(paid),cx+cw/2,y,{s:50,w:'800',c:isVoid?C.grey:C.ink,a:'center',sp:-.5});y+=66;
  const st=isVoid?{t:'Voided',c:C.bad,k:'bad'}:(s.balanceDue>0?{t:'Part Payment',c:C.warn,k:'warn'}:{t:'Payment Successful',c:'#13803a',k:'ok'});
  y+=statusPill(ctx,st.t,st.c,st.k,cx+cw/2,y)+20;
  y+=infoCard(ctx,x0,y,iw,[{icon:'receipt',label:'Receipt No',value:s.receiptNo},{icon:'calendar',label:'Date',value:stamp(s.createdAt)},{icon:'person',label:'Customer',value:s.customerName||'Walk-in customer'},{icon:'card',label:'Payment Method',value:methodsOf(s.payments)}])+12;
  const sub=[s.branchName?'Branch: '+s.branchName:'',s.cashier?'Served by: '+s.cashier:''].filter(Boolean).join('   ·   ');
  if(sub){setFont(ctx,'500',12.5);wrap(ctx,sub,iw,2).forEach(l=>{txt(ctx,l,cx+cw/2,y,{s:12.5,c:C.mut,a:'center'});y+=17});y+=4}
  y+=10;
  /* items */
  const items=s.items||[];setFont(ctx,'700',15);
  const rows=items.map(it=>{const ls=wrap(ctx,it.name,iw-32-120,3);return {it,ls,h:ls.length*20+18+22}});
  const bodyH=rows.reduce((a,r)=>a+r.h,0)+4;
  rrTop(ctx,x0,y,iw,42,14);ctx.fillStyle='#15171c';ctx.fill();
  txt(ctx,'Items Purchased',x0+18,y+21.5,{s:15,w:'700',c:'#fff',b:'middle'});txt(ctx,'Amount',xr-18,y+21.5,{s:15,w:'700',c:'#fff',a:'right',b:'middle'});y+=42;
  rrBottom(ctx,x0,y,iw,bodyH,14);ctx.fillStyle='#ffffff';ctx.fill();ctx.strokeStyle='#e4e1d6';ctx.lineWidth=1;ctx.stroke();
  let ry=y+4;
  rows.forEach((r,i)=>{
    r.ls.forEach((l,j)=>txt(ctx,l,x0+18,ry+12+j*20,{s:15,w:'700',c:C.ink}));
    txt(ctx,fmt(r.it.lineTotal),xr-18,ry+12,{s:15,w:'700',c:C.ink,a:'right'});
    txt(ctx,r.it.qty+' x '+fmt(r.it.unitPrice),x0+18,ry+12+r.ls.length*20,{s:13.5,c:C.mut});
    ry+=r.h;if(i<rows.length-1)hairline(ctx,x0+18,xr-18,ry-6,'#ebe8dd');
  });
  y+=bodyH+22;
  /* totals */
  y+=row(ctx,'Subtotal',fmt(s.subtotal),x0+16,xr-16,y);
  if(s.discount>0)y+=row(ctx,'Discount','-'+fmt(s.discount),x0+16,xr-16,y,{vc:C.ok});
  if(s.vatRate>0)y+=row(ctx,'VAT ('+s.vatRate+'%)'+(s.vatInclusive?' incl.':''),fmt(s.tax),x0+16,xr-16,y);
  y+=8;y+=totalBand(ctx,x0,y,iw,'Total',fmt(s.total),'lg')+18;
  const extra=(s.payments||[]).length>1||s.change>0||(s.balanceDue>0&&!isVoid);
  if(extra){
    if((s.payments||[]).length>1||s.change>0)(s.payments||[]).forEach(p=>{y+=row(ctx,'Paid ('+cap(p.method)+')',fmt(p.amount),x0+16,xr-16,y,{ls:14,vs:14,h:26})});
    if(s.change>0)y+=row(ctx,'Change given',fmt(s.change),x0+16,xr-16,y,{ls:14,vs:14,h:26});
    if(s.balanceDue>0&&!isVoid)y+=row(ctx,'Balance owed',fmt(s.balanceDue),x0+16,xr-16,y,{lc:C.warn,lw:'800',vc:C.warn,vw:'800',vs:17,ls:16,h:32});
    y+=6;
  }
  y+=12;
  y=footer(ctx,o,logo,cx,cw,x0,xr,y,h.footer||'Thank you for your patronage!','');
  y+=22;
  const end=y+WAVE;
  if(isVoid)watermark(ctx,'VOIDED',C.bad,cx+cw/2,top+(y-top)*.5,96);
  bottomWave(ctx,cx,end-WAVE,cw,WAVE);
  ctx.restore();
  return end;
}

/* ======================= INVOICE ======================= */
function invStatus(inv){
  const st=String(inv.status||'').toLowerCase();
  if(st==='paid')return {t:'Paid',c:'#13803a',k:'ok',m:'PAID'};
  if(st==='void')return {t:'Void',c:C.bad,k:'bad',m:'VOID'};
  if(st==='draft')return {t:'Draft',c:C.grey,k:'warn',m:'DRAFT'};
  if(st==='overdue')return {t:'Overdue',c:C.bad,k:'bad',m:''};
  if(st==='partial')return {t:'Part Paid',c:C.warn,k:'warn',m:''};
  if(st==='unpaid')return {t:'Unpaid',c:C.warn,k:'warn',m:''};
  return {t:st?cap(st):'Invoice',c:C.warn,k:'warn',m:''};
}
function layoutInvoice(ctx,inv,b,logo,H,o){
  const W=820,P=o.pad,cx=P,cw=W-2*P,x0=cx+28,iw=cw-56,xr=x0+iw,top=P,sv=invStatus(inv),WAVE=78;
  cardBase(ctx,cx,top,cw,H-2*P,o);
  const hh=header(ctx,o,cx,top,cw,b.name,b.address,b.phone,b.tin,b.email,true);
  let y=top+hh+24;
  y+=titlePill(ctx,'INVOICE',x0+6,xr-6,y)+24;
  const showTotal=sv.t==='Paid'||sv.t==='Draft'||sv.t==='Void'||sv.t==='Invoice';
  txt(ctx,sv.t==='Paid'?'TOTAL PAID':(showTotal?'TOTAL':'AMOUNT DUE'),cx+cw/2,y,{s:15,w:'700',c:C.ink,a:'center',sp:5});y+=28;
  txt(ctx,fmt(showTotal?inv.total:inv.balanceDue),cx+cw/2,y,{s:52,w:'800',c:sv.t==='Void'?C.grey:C.ink,a:'center',sp:-.5});y+=68;
  y+=statusPill(ctx,sv.t,sv.c,sv.k,cx+cw/2,y)+22;
  y+=infoCard(ctx,x0,y,iw,[{icon:'receipt',label:'Invoice No',value:inv.invoiceNo||'Draft'},{icon:'calendar',label:'Issue Date',value:day(inv.issueDate)},{icon:'clock',label:'Due Date',value:day(inv.dueDate)},{icon:'person',label:'Billed To',value:inv.customerName||'Customer'}])+12;
  const contact=[inv.customerPhone,inv.customerEmail].filter(Boolean).join('   ·   ');
  if(contact){txt(ctx,contact,cx+cw/2,y,{s:12.5,c:C.mut,a:'center'});y+=20}
  y+=10;
  /* items */
  const cQ=xr-300,cP=xr-170,items=inv.items||[];setFont(ctx,'700',15);
  const rows=items.map(it=>{const ls=wrap(ctx,it.description,cQ-x0-60,4);return {it,ls,h:Math.max(50,ls.length*20+28)}});
  const bodyH=rows.reduce((a,r)=>a+r.h,0)+4;
  rrTop(ctx,x0,y,iw,42,14);ctx.fillStyle='#15171c';ctx.fill();
  const hy=y+21.5;txt(ctx,'Description',x0+18,hy,{s:15,w:'700',c:'#fff',b:'middle'});
  txt(ctx,'Qty',cQ,hy,{s:15,w:'700',c:'#fff',a:'right',b:'middle'});txt(ctx,'Price',cP,hy,{s:15,w:'700',c:'#fff',a:'right',b:'middle'});txt(ctx,'Amount',xr-18,hy,{s:15,w:'700',c:'#fff',a:'right',b:'middle'});y+=42;
  rrBottom(ctx,x0,y,iw,bodyH,14);ctx.fillStyle='#ffffff';ctx.fill();ctx.strokeStyle='#e4e1d6';ctx.lineWidth=1;ctx.stroke();
  let ry=y+2;
  rows.forEach((r,i)=>{
    const my=ry+(r.h-r.ls.length*20)/2;r.ls.forEach((l,j)=>txt(ctx,l,x0+18,my+j*20,{s:15,w:'700',c:C.ink}));
    const cy=ry+r.h/2;
    txt(ctx,String(r.it.qty),cQ,cy,{s:15,w:'600',c:C.ink,a:'right',b:'middle'});txt(ctx,fmt(r.it.unitPrice),cP,cy,{s:14,w:'500',c:C.mut,a:'right',b:'middle'});txt(ctx,fmt(r.it.lineTotal),xr-18,cy,{s:15,w:'700',c:C.ink,a:'right',b:'middle'});
    ry+=r.h;if(i<rows.length-1)hairline(ctx,x0+18,xr-18,ry,'#ebe8dd');
  });
  y+=bodyH+22;
  /* totals */
  const tw=360,tx=xr-tw;
  y+=row(ctx,'Subtotal',fmt(inv.subtotal),tx+16,xr-16,y);
  if(inv.discount>0)y+=row(ctx,'Discount','-'+fmt(inv.discount),tx+16,xr-16,y,{vc:C.ok});
  if(inv.vatRate>0)y+=row(ctx,'VAT ('+inv.vatRate+'%)'+(inv.vatInclusive?' incl.':''),fmt(inv.tax),tx+16,xr-16,y);
  const hasPaid=inv.paid>0;
  if(hasPaid){y+=row(ctx,'Total',fmt(inv.total),tx+16,xr-16,y,{lc:C.ink,lw:'700',vw:'800'});y+=row(ctx,'Paid','-'+fmt(inv.paid),tx+16,xr-16,y,{vc:C.ok})}
  y+=8;y+=totalBand(ctx,tx,y,tw,hasPaid?'Balance Due':'Total Due',fmt(hasPaid?inv.balanceDue:inv.total),'md')+24;
  /* notes / terms */
  [['NOTES',inv.notes],['TERMS',inv.terms]].forEach(n=>{
    if(!n[1])return;setFont(ctx,'500',13);const ls=wrap(ctx,n[1],iw-36,7);const bh=18+16+ls.length*19+10;
    rr(ctx,x0,y,iw,bh,14);ctx.fillStyle='#fbf7e8';ctx.fill();ctx.strokeStyle='#efe3b8';ctx.lineWidth=1;ctx.stroke();
    txt(ctx,n[0],x0+18,y+16,{s:11,w:'700',c:C.mut,sp:1.6});ls.forEach((l,j)=>txt(ctx,l,x0+18,y+38+j*19,{s:13,c:'#4a463c'}));y+=bh+14;
  });
  y+=8;
  y=footer(ctx,o,logo,cx,cw,x0,xr,y,'Thank you for your business.','');
  y+=22;
  const end=y+WAVE;
  if(sv.m)watermark(ctx,sv.m,sv.c,cx+cw/2,top+(y-top)*.55,130);
  bottomWave(ctx,cx,end-WAVE,cw,WAVE);
  ctx.restore();
  return end;
}

/* ======================= render / share ======================= */
async function render(type,data,biz,opts){
  opts=opts||{};const logo=await loadLogo();const blogo=biz&&biz.logo?await loadImg(biz.logo):null;
  const inv=type==='invoice',W=inv?820:600;
  const o={pad:opts.bare?0:(inv?28:24),bare:!!opts.bare,outer:opts.bare?'#ffffff':'#f3ecd5',blogo:blogo};
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
