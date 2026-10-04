/* BOLTIV receipt sharing + WhatsApp support.
   - Transaction popup (transactions page) and receipt page: "SHARE RECEIPT" and "NEED HELP? WHATSAPP" buttons.
   - Dashboard: small floating WhatsApp support button.
   Read-only: it only reads what is already on screen. If anything fails, the page behaves as before. */
(function(){
  'use strict';
  var SUPPORT_NUMBER='2347086836820';
  var SITE='boltiv.ng';

  function clean(t){return String(t==null?'':t).replace(/\s+/g,' ').trim();}

  // Collect "label: value" pairs from the detail rows already rendered on the page.
  function readRows(container){
    var out=[];
    var rows=container.querySelectorAll('.detail-row,.row');
    for(var i=0;i<rows.length;i++){
      var label=rows[i].querySelector('span');
      var value=rows[i].querySelector('strong');
      if(!label||!value)continue;
      var l=clean(label.textContent),v=clean(value.textContent);
      if(!l||!v||v==='-')continue;
      if(/^provider (ref|reference)$/i.test(l))continue; // internal, not useful to share
      out.push([l,v]);
    }
    return out;
  }
  function find(rows,label){
    for(var i=0;i<rows.length;i++){if(rows[i][0].toLowerCase()===label.toLowerCase())return rows[i][1];}
    return '';
  }
  function receiptText(rows,status){
    var service=find(rows,'Service'),amount=find(rows,'Amount');
    var ok=/success/i.test(status);
    var lines=[(ok?'\u2705 ':'\uD83D\uDCC4 ')+'BOLTIV Receipt',(service?service+' ':'')+(amount?'- '+amount:'')];
    rows.forEach(function(r){
      var l=r[0].toLowerCase();
      if(l==='service'||l==='amount')return;
      lines.push(r[0]+': '+r[1]);
    });
    if(status)lines.push('Status: '+status);
    lines.push('');
    lines.push('Fast. Simple. Powerful. '+SITE);
    if(window.boltivReferralLink)lines.push('Join me on BOLTIV: '+window.boltivReferralLink);
    return lines.join('\n');
  }
  function shareText(text){
    if(navigator.share){
      navigator.share({text:text}).catch(function(){});
      return;
    }
    window.open('https://wa.me/?text='+encodeURIComponent(text),'_blank','noopener');
  }

  /* ---------- receipt as an image (logo, status, details) ---------- */
  var logoImg=null,logoReady=null;
  function loadLogo(){
    if(logoReady)return logoReady;
    logoReady=new Promise(function(resolve){
      var img=new Image();
      img.onload=function(){logoImg=img;resolve(img);};
      img.onerror=function(){resolve(null);};
      img.src='/assets/boltiv-logo.webp';
    });
    return logoReady;
  }
  function wrapLines(ctx,text,maxW){
    var words=String(text).split(' '),lines=[],line='';
    function pushLong(w){ // break a single long token (e.g. a reference) by characters
      var chunk='';
      for(var i=0;i<w.length;i++){
        if(ctx.measureText(chunk+w[i]).width>maxW&&chunk){lines.push(chunk);chunk='';}
        chunk+=w[i];
      }
      return chunk;
    }
    for(var i=0;i<words.length;i++){
      var test=line?line+' '+words[i]:words[i];
      if(ctx.measureText(test).width<=maxW){line=test;continue;}
      if(line){lines.push(line);line='';}
      if(ctx.measureText(words[i]).width>maxW)line=pushLong(words[i]);else line=words[i];
    }
    if(line)lines.push(line);
    return lines.length?lines:[''];
  }
  function roundRect(ctx,x,y,w,h,r){
    ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();
  }
  function statusStyle(status){
    var s=String(status||'').toLowerCase();
    if(/success/.test(s))return{color:'#1f9d55',soft:'#e8f7ee',title:'Transaction Successful',mark:'check'};
    if(/pend|process|initiat/.test(s))return{color:'#d98a00',soft:'#fff4de',title:'Transaction Pending',mark:'clock'};
    if(/refund/.test(s))return{color:'#4a6fa5',soft:'#eaf0f8',title:'Transaction Refunded',mark:'back'};
    return{color:'#c0392b',soft:'#fdecea',title:'Transaction Failed',mark:'cross'};
  }
  function drawMark(ctx,kind,cx,cy,r,color){
    ctx.fillStyle=color;ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='#fff';ctx.lineWidth=r*0.16;ctx.lineCap='round';ctx.lineJoin='round';
    ctx.beginPath();
    if(kind==='check'){ctx.moveTo(cx-r*0.42,cy+r*0.02);ctx.lineTo(cx-r*0.1,cy+r*0.34);ctx.lineTo(cx+r*0.46,cy-r*0.32);}
    else if(kind==='cross'){ctx.moveTo(cx-r*0.32,cy-r*0.32);ctx.lineTo(cx+r*0.32,cy+r*0.32);ctx.moveTo(cx+r*0.32,cy-r*0.32);ctx.lineTo(cx-r*0.32,cy+r*0.32);}
    else if(kind==='clock'){ctx.moveTo(cx,cy-r*0.45);ctx.lineTo(cx,cy);ctx.lineTo(cx+r*0.32,cy+r*0.2);}
    else{ctx.moveTo(cx+r*0.4,cy+r*0.1);ctx.lineTo(cx-r*0.3,cy+r*0.1);ctx.moveTo(cx-r*0.05,cy-r*0.25);ctx.lineTo(cx-r*0.35,cy+r*0.1);ctx.lineTo(cx-r*0.05,cy+r*0.45);}
    ctx.stroke();
  }
  function renderReceiptImage(rows,status){
    return loadLogo().then(function(logo){
      var FONT='"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
      var W=1080,PAD=54,CARD_X=PAD,CARD_W=W-PAD*2,IN=64,LEFT=CARD_X+IN,RIGHT=CARD_X+CARD_W-IN,CONTENT_W=RIGHT-LEFT;
      var st=statusStyle(status);
      var service=find(rows,'Service'),amount=find(rows,'Amount');
      var skip={service:1,amount:1,status:1,'provider ref':1,'provider reference':1,time:1};
      var date=find(rows,'Date'),time=find(rows,'Time');
      var detail=[];
      rows.forEach(function(r){
        var l=r[0].toLowerCase();
        if(skip[l]&&l!=='time')return;
        if(l==='time')return;
        if(l==='date'){detail.push(['Date',time?date+', '+time:date]);return;}
        detail.push(r);
      });
      // measure first
      var probe=document.createElement('canvas').getContext('2d');
      var VAL_MAX=CONTENT_W*0.62;
      var layout=detail.map(function(r){
        var isRef=/^reference$/i.test(r[0]),isToken=/token/i.test(r[0]);
        var size=isRef?30:(isToken?36:34);
        var maxW=isRef?CONTENT_W-200:VAL_MAX;
        probe.font='700 '+size+'px '+FONT;
        if(isRef){while(size>22&&probe.measureText(r[1]).width>maxW){size-=1;probe.font='700 '+size+'px '+FONT;}}
        var lines=wrapLines(probe,r[1],maxW);
        return{label:r[0],lines:lines,size:size,h:Math.max(44,lines.length*(size+10))+44};
      });
      var rowsH=layout.reduce(function(a,x){return a+x.h;},0);
      var logoH=logo?170:0;
      var topH=60+logoH+(logo?20:0)+46+30; // logo, wordmark, tagline
      var statusH=70+120+24+60+ (service?52:0)+50; // badge, title, amount, service
      var footerH=235;
      var H=PAD+topH+statusH+rowsH+footerH+PAD;
      var scale=1;
      var c=document.createElement('canvas');c.width=W*scale;c.height=H*scale;
      var ctx=c.getContext('2d');ctx.scale(scale,scale);
      // page background
      ctx.fillStyle='#f6f1e1';ctx.fillRect(0,0,W,H);
      // card
      ctx.save();ctx.shadowColor='rgba(0,0,0,.12)';ctx.shadowBlur=40;ctx.shadowOffsetY=12;
      roundRect(ctx,CARD_X,PAD,CARD_W,H-PAD*2,44);ctx.fillStyle='#ffffff';ctx.fill();ctx.restore();
      ctx.save();roundRect(ctx,CARD_X,PAD,CARD_W,H-PAD*2,44);ctx.clip();
      // gold top band
      var g=ctx.createLinearGradient(CARD_X,0,CARD_X+CARD_W,0);g.addColorStop(0,'#b8860b');g.addColorStop(.5,'#e8c75a');g.addColorStop(1,'#b8860b');
      ctx.fillStyle=g;ctx.fillRect(CARD_X,PAD,CARD_W,16);
      // faint watermark
      if(logo){ctx.globalAlpha=0.045;var wh=620,ww=wh*logo.width/logo.height;ctx.drawImage(logo,W/2-ww/2,H/2-wh/2+60,ww,wh);ctx.globalAlpha=1;}
      ctx.restore();
      var y=PAD+16+50;
      ctx.textAlign='center';ctx.textBaseline='alphabetic';
      if(logo){var lh=logoH,lw=lh*logo.width/logo.height;ctx.drawImage(logo,W/2-lw/2,y,lw,lh);y+=lh+20;}
      ctx.fillStyle='#171717';ctx.font='900 46px '+FONT;
      try{ctx.letterSpacing='10px';}catch(e){}
      ctx.fillText('BOLTIV',W/2+5,y+36);
      try{ctx.letterSpacing='0px';}catch(e){}
      y+=36+14;
      ctx.fillStyle='#8a8a84';ctx.font='500 26px '+FONT;ctx.fillText('Fast. Simple. Powerful.',W/2,y+22);
      y+=22+34;
      // status
      drawMark(ctx,st.mark,W/2,y+60,56,st.color);
      y+=120+24;
      ctx.fillStyle=st.color;ctx.font='800 38px '+FONT;ctx.fillText(st.title,W/2,y+30);
      y+=30+30;
      ctx.fillStyle='#171717';ctx.font='900 78px '+FONT;ctx.fillText(amount||'',W/2,y+62);
      y+=62+ (service?14:0);
      if(service){ctx.fillStyle='#6b6b66';ctx.font='600 32px '+FONT;ctx.fillText(service,W/2,y+34);y+=34+10;}
      y+=40;
      // divider
      ctx.strokeStyle='#d9d9d2';ctx.lineWidth=3;ctx.setLineDash([12,10]);
      ctx.beginPath();ctx.moveTo(LEFT,y);ctx.lineTo(RIGHT,y);ctx.stroke();ctx.setLineDash([]);
      y+=6;
      // rows
      layout.forEach(function(r,i){
        var top=y+22;
        ctx.textAlign='left';ctx.fillStyle='#8a8a84';ctx.font='500 30px '+FONT;
        ctx.fillText(r.label,LEFT,top+34);
        ctx.textAlign='right';ctx.fillStyle='#171717';ctx.font='700 '+r.size+'px '+FONT;
        r.lines.forEach(function(line,k){ctx.fillText(line,RIGHT,top+34+k*(r.size+10));});
        y+=r.h;
        if(i<layout.length-1){ctx.strokeStyle='#efefe9';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(LEFT,y);ctx.lineTo(RIGHT,y);ctx.stroke();}
      });
      // footer
      y+=22;
      ctx.strokeStyle='#d9d9d2';ctx.lineWidth=3;ctx.setLineDash([12,10]);
      ctx.beginPath();ctx.moveTo(LEFT,y);ctx.lineTo(RIGHT,y);ctx.stroke();ctx.setLineDash([]);
      y+=56;
      ctx.textAlign='center';ctx.fillStyle='#171717';ctx.font='800 32px '+FONT;ctx.fillText('Thank you for choosing BOLTIV',W/2,y);
      y+=48;
      ctx.fillStyle='#b8860b';ctx.font='800 32px '+FONT;ctx.fillText('boltiv.ng',W/2,y);
      return new Promise(function(resolve,reject){
        c.toBlob(function(b){b?resolve(b):reject(new Error('toBlob failed'));},'image/png');
      });
    });
  }
  function downloadBlob(blob,name){
    var url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=name;document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(url);a.remove();},1500);
  }
  function shareReceipt(rows,status,button){
    var text=receiptText(rows,status);
    var original=button?button.textContent:'';
    if(button){button.disabled=true;button.textContent='PREPARING RECEIPT...';}
    function done(){if(button){button.disabled=false;button.textContent=original;}}
    return renderReceiptImage(rows,status).then(function(blob){
      var ref=(find(rows,'Reference')||'receipt').replace(/[^A-Za-z0-9-]/g,'').slice(-14);
      var file=null;
      try{file=new File([blob],'BOLTIV-receipt-'+ref+'.png',{type:'image/png'});}catch(e){}
      if(file&&navigator.canShare&&navigator.canShare({files:[file]})){
        return navigator.share({files:[file],text:window.boltivReferralLink?('BOLTIV receipt\nJoin me on BOLTIV: '+window.boltivReferralLink):'BOLTIV receipt \u2022 boltiv.ng'});
      }
      if(file){downloadBlob(blob,file.name);return;}
      shareText(text);
    }).catch(function(error){
      if(error&&error.name==='AbortError')return; // customer closed the share sheet
      shareText(text);
    }).then(done,done);
  }

  function helpLink(rows,status){
    var ref=find(rows,'Reference'),service=find(rows,'Service'),amount=find(rows,'Amount');
    var msg='Hello BOLTIV support, I need help with a transaction.'+
      (service?'\nService: '+service:'')+(amount?'\nAmount: '+amount:'')+
      (ref?'\nReference: '+ref:'')+(status?'\nStatus: '+status:'');
    return 'https://wa.me/'+SUPPORT_NUMBER+'?text='+encodeURIComponent(msg);
  }

  function buildButtons(getRows,getStatus){
    var wrap=document.createElement('div');
    wrap.className='boltiv-share-actions';
    wrap.style.cssText='display:grid;gap:10px;margin:14px 0 4px;';
    var share=document.createElement('button');
    share.type='button';
    share.textContent='SHARE RECEIPT';
    share.style.cssText='border:0;border-radius:13px;padding:13px;background:#25D366;color:#fff;font-weight:900;font-size:12px;letter-spacing:.04em;cursor:pointer;';
    share.onclick=function(){
      var rows=getRows();
      if(!rows.length)return;
      shareReceipt(rows,getStatus(),share);
    };
    var help=document.createElement('a');
    help.textContent='NEED HELP? CHAT ON WHATSAPP';
    help.target='_blank';
    help.rel='noopener noreferrer';
    help.style.cssText='display:block;text-align:center;border:1px solid var(--t-bd-e5e5e1);border-radius:13px;padding:12px;background:var(--t-bg-ffffff);color:var(--t-fg-171717);font-weight:900;font-size:11px;text-decoration:none;';
    help.onclick=function(){help.href=helpLink(getRows(),getStatus());};
    help.href='https://wa.me/'+SUPPORT_NUMBER;
    wrap.appendChild(share);
    wrap.appendChild(help);
    return wrap;
  }

  /* ---------- transactions page popup ---------- */
  function mountPopup(){
    var details=document.getElementById('modalDetails');
    if(!details||!details.parentNode)return;
    var statusEl=document.getElementById('modalStatus');
    function place(){
      var old=document.querySelector('.boltiv-share-actions');
      if(old)old.remove();
      if(!details.querySelector('.detail-row'))return;
      var anchor=document.getElementById('transactionNote')||details;
      var rows0=readRows(details);
      if(!find(rows0,'Reference'))return;
      var buttons=buildButtons(function(){return readRows(details);},function(){return statusEl?clean(statusEl.textContent).replace(/^[^A-Za-z]+/,''):'';});
      anchor.parentNode.insertBefore(buttons,anchor.nextSibling);
    }
    // the page rewrites modalDetails each time a transaction is opened
    new MutationObserver(function(){setTimeout(place,0);}).observe(details,{childList:true});
  }

  /* ---------- receipt page ---------- */
  function mountReceipt(){
    var details=document.getElementById('details');
    if(!details||!details.parentNode||!document.querySelector('.receipt-card'))return;
    var statusEl=document.getElementById('status');
    new MutationObserver(function(){
      if(document.querySelector('.boltiv-share-actions'))return;
      if(!details.querySelector('.row'))return;
      var buttons=buildButtons(function(){return readRows(details);},function(){return statusEl?clean(statusEl.textContent):'';});
      details.parentNode.insertBefore(buttons,details.nextSibling);
    }).observe(details,{childList:true});
  }

  /* ---------- dashboard floating support button ---------- */
  function mountFloating(){
    if(!document.querySelector('.home-balance-card')||document.getElementById('boltivWhatsappFab'))return;
    var a=document.createElement('a');
    a.id='boltivWhatsappFab';
    a.href='https://wa.me/'+SUPPORT_NUMBER+'?text='+encodeURIComponent('Hello BOLTIV support, I need help.');
    a.target='_blank';
    a.rel='noopener noreferrer';
    a.setAttribute('aria-label','Chat with BOLTIV support on WhatsApp');
    a.style.cssText='position:fixed;right:16px;bottom:calc(92px + env(safe-area-inset-bottom,0px));width:52px;height:52px;border-radius:50%;background:#25D366;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(0,0,0,.28);z-index:900;text-decoration:none;';
    a.innerHTML='<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 20.5l1.7-5A8.4 8.4 0 1 1 21 11.5Z"/><path d="M8.5 10h7M8.5 13.500h4.5"/></svg>';
    document.body.appendChild(a);
  }

  function start(){
    try{if(document.getElementById('modalDetails')||document.getElementById('details'))loadLogo();}catch(e){}
    try{mountPopup();}catch(e){}
    try{mountReceipt();}catch(e){}
    try{mountFloating();}catch(e){}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
